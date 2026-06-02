import { randomBytes } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { hashPassword, verifyPassword } from '../../common/utils/password.util';
import { User } from '../users/entities/user.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { ReferralEvent } from '../referrals/entities/referral-event.entity';
import {
  AuthProvider,
  ExamType,
  SchoolLevel,
  UserRole,
} from '../../common/types/enums';
import { RedisService } from '../../common/redis/redis.service';
import { CacheKeys } from '../../common/utils/cache-keys.util';
import { RegisterDto } from './dto/register.dto';
import { TokensService, TokenPair } from './tokens.service';
import { OtpService } from './otp.service';
import { GoogleOAuthService } from './google-oauth.service';
import { ReferralsService } from '../referrals/referrals.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationChannel } from '../../common/types/enums';
import { MailService } from '../mail/mail.service';
import { MailEvent } from '../mail/mail.types';

const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_TTL_SECONDS = 15 * 60;

function generateReferralCode(fullName: string): string {
  const prefix = randomBytes(2).toString('hex').toUpperCase().slice(0, 4);
  const suffix = (
    fullName.replace(/[^A-Za-z]/g, '').toUpperCase() + 'GHN'
  ).slice(0, 3);
  return `PM-${prefix}-${suffix}`;
}

function schoolLevelFor(examType: ExamType): SchoolLevel {
  return examType === ExamType.BECE ? SchoolLevel.JHS : SchoolLevel.SHS;
}

export interface SafeUser {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  role: UserRole;
  examType: ExamType;
  schoolLevel: SchoolLevel;
  // NULL for remedial (NOVDEC) users — they aren't enrolled in a school
  // cohort so form-level is meaningless.
  formLevel: number | null;
  schoolName: string | null;
  region: string | null;
  avatarUrl: string | null;
  referralCode: string;
  referralQualified: boolean;
  levelXp: number;
  spendableXp: number;
  currentLevel: number;
  streakDays: number;
  longestStreak: number;
  countryCode: string;
  isActive: boolean;
  createdAt: Date;
}

/**
 * Flattened subscription shape returned alongside the SafeUser on
 * GET /auth/me. Mirrors `MeSubscriptionView` in SubscriptionsService —
 * kept separate to avoid an auth → subscriptions service import (which
 * would re-export through the module barrel and risk a circular).
 */
export interface AuthMeSubscriptionView {
  id: string;
  userId: string;
  planId: string | null;
  billingInterval: 'monthly' | 'six_month' | 'annual' | null;
  provider: string | null;
  providerReference: string | null;
  providerSubscriptionId: string | null;
  providerCustomerId: string | null;
  xpRedemptionId: string | null;
  amountGhs: string | null;
  countryCode: string;
  status: string;
  startsAt: string | null;
  expiresAt: string | null;
  createdAt?: string;
  updatedAt?: string;
  account: 'free' | 'plus' | 'pro';
  level: 'bece' | 'wassce' | 'novdec' | null;
  paymentKind: 'one_time' | 'recurring' | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    @InjectRepository(Subscription)
    private readonly subsRepo: Repository<Subscription>,
    @InjectRepository(ReferralEvent)
    private readonly referralsRepo: Repository<ReferralEvent>,
    private readonly tokens: TokensService,
    private readonly otp: OtpService,
    private readonly google: GoogleOAuthService,
    private readonly redis: RedisService,
    private readonly referrals: ReferralsService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
  ) {}

  /**
   * Allocate a globally unique referral code. Retries on the rare UNIQUE
   * collision.
   */
  private async allocateReferralCode(fullName: string): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const code = generateReferralCode(fullName);
      const clash = await this.usersRepo.findOne({
        where: { referralCode: code },
      });
      if (!clash) return code;
    }
    return `${generateReferralCode(fullName)}-${randomBytes(2)
      .toString('hex')
      .toUpperCase()}`;
  }

  /**
   * Link a new user to the referrer identified by `referralCode` and insert
   * the referral_event row. The gamification service awards the corresponding
   * XP events (referral_referred to referrer, referral_new_user to new user)
   * after this call returns.
   *
   * Self-referral fraud defense: skip when
   *   - the referrer is the new user (same row),
   *   - the referrer's currently-bound deviceId matches the new user's
   *     incoming deviceId (same physical phone reusing fresh emails),
   *   - the referrer's phone or email prefix exactly matches the new
   *     account's contact (trivial alias farming).
   *
   * These checks block the trivial farm path; sophisticated actors will
   * still find ways around them, so anomalous referral patterns should
   * still be flagged by ops dashboards.
   */
  private async recordReferralSignup(
    newUser: User,
    referralCode: string,
    deviceId?: string,
  ): Promise<void> {
    const referrer = await this.usersRepo.findOne({
      where: { referralCode },
    });
    if (!referrer || referrer.id === newUser.id) return;

    // Device collision — if the referrer is currently signed in on the
    // same physical device, treat as self-referral.
    if (deviceId) {
      const sameDevice: { '?column?': number }[] =
        await this.usersRepo.manager.query(
          `select 1 from device_sessions where user_id = $1 and device_id = $2 limit 1`,
          [referrer.id, deviceId],
        );
      if (sameDevice.length > 0) {
        this.logger.warn(
          `[referral] device collision: new_user=${newUser.id} referrer=${referrer.id} device=${deviceId} — skipping reward`,
        );
        return;
      }
    }

    // Contact overlap — same phone, same email local-part. Catches the
    // "+1" / dotted-email tricks.
    const newLocal = newUser.email?.split('@')[0]?.toLowerCase();
    const refLocal = referrer.email?.split('@')[0]?.toLowerCase();
    if (
      (newUser.phone && referrer.phone && newUser.phone === referrer.phone) ||
      (newLocal && refLocal && newLocal === refLocal)
    ) {
      this.logger.warn(
        `[referral] contact overlap: new_user=${newUser.id} referrer=${referrer.id} — skipping reward`,
      );
      return;
    }

    await this.usersRepo.update(newUser.id, { referredBy: referrer.id });
    await this.referralsRepo.insert({
      referrerId: referrer.id,
      referredId: newUser.id,
      referralCode,
    });
  }

  async register(
    dto: RegisterDto,
    req: { ip?: string; userAgent?: string },
  ): Promise<{ user: SafeUser; tokens: TokenPair }> {
    if (!dto.email && !dto.phone) {
      throw new BadRequestException('Either email or phone is required');
    }
    if (dto.email) {
      const taken = await this.usersRepo.findOne({
        where: { email: dto.email },
      });
      if (taken) throw new ConflictException('Email already registered');
    }
    if (dto.phone) {
      const taken = await this.usersRepo.findOne({
        where: { phone: dto.phone },
      });
      if (taken) throw new ConflictException('Phone already registered');
    }
    const passwordHash = dto.password ? await hashPassword(dto.password) : null;

    // NOVDEC users have no form level — remedial students aren't enrolled
    // by form. The DTO's `ValidateIf` enforces "form required iff not
    // NOVDEC"; here we collapse the value to null for NOVDEC so a client
    // that sent a stale sentinel can't accidentally populate the column.
    const resolvedFormLevel =
      dto.examType === ExamType.NOVDEC ? null : (dto.formLevel ?? null);

    const user = this.usersRepo.create({
      fullName: dto.fullName,
      email: dto.email ?? null,
      phone: dto.phone ?? null,
      passwordHash,
      // Provider is derived server-side from the credentials shape:
      // phone-only → PHONE, email+password → EMAIL. Google has its own
      // endpoint (auth.controller.google) and never reaches this path.
      authProvider: dto.phone ? AuthProvider.PHONE : AuthProvider.EMAIL,
      examType: dto.examType,
      schoolLevel: schoolLevelFor(dto.examType),
      formLevel: resolvedFormLevel,
      referralCode: await this.allocateReferralCode(dto.fullName),
      schoolName: dto.schoolName ?? null,
      region: dto.region ?? null,
      role: UserRole.STUDENT,
    });
    await this.usersRepo.save(user);

    if (dto.referralCode) {
      await this.recordReferralSignup(user, dto.referralCode, dto.deviceId);
      // issueSignupRewards reads the referral_event row to decide whether
      // to award XP — when recordReferralSignup short-circuits on
      // fraud-suspicion, no row exists and this becomes a no-op.
      await this.referrals.issueSignupRewards(user.id);
    }

    if (!dto.deviceId) {
      // Controller already enforces this via pickDeviceId(); belt + braces.
      throw new BadRequestException(
        'deviceId is required (send via X-Device-ID header or body).',
      );
    }
    const tokens = await this.tokens.issuePair(user, {
      deviceId: dto.deviceId,
      deviceName: dto.deviceName,
      ip: req.ip,
    });

    // Spec §2.3 step 6: welcome push notification.
    await this.notifications
      .send({
        userId: user.id,
        channel: NotificationChannel.PUSH,
        title: `Welcome to Bondzi, ${user.fullName.split(' ')[0]}!`,
        body: 'Answer your first question to start earning XP.',
        data: { type: 'welcome' },
      })
      .catch(() => void 0);

    // Welcome email — best-effort. MailService never throws (see its
    // contract), so a Resend outage here can't fail registration. Only
    // sent when the user gave us an email address (phone-only signups
    // get the push above and skip email until they add one in settings).
    if (user.email) {
      await this.mail.send(MailEvent.WELCOME, user.email, {
        recipientName: user.fullName.split(' ')[0],
        examType: user.examType.toUpperCase(),
      });
    }

    return { user: this.toSafeUser(user), tokens };
  }

  async login(
    email: string,
    password: string,
    req: { ip?: string; deviceId: string; deviceName?: string },
  ): Promise<{ user: SafeUser; tokens: TokenPair }> {
    // CRITICAL: two independent lockout buckets — by IP AND by email.
    // The previous shape used `ip || email`, so once `trust proxy` was
    // fixed, every legitimate user behind the same NAT (a school's
    // internet share) collided with each other; conversely, an attacker
    // rotating IPs trivially evaded the per-email count. Both buckets
    // get tripped before we let the request through.
    const ipKey = req.ip ? CacheKeys.loginAttempts(`ip:${req.ip}`) : null;
    const emailKey = CacheKeys.loginAttempts(`email:${email.toLowerCase()}`);
    const ipAttempts = ipKey
      ? await this.redis.incr(ipKey, LOGIN_LOCKOUT_TTL_SECONDS)
      : 0;
    const emailAttempts = await this.redis.incr(
      emailKey,
      LOGIN_LOCKOUT_TTL_SECONDS,
    );
    if (
      emailAttempts > MAX_LOGIN_ATTEMPTS ||
      // IP bucket is wider so a single bad actor doesn't lock the whole
      // NAT — 10× the per-email cap.
      ipAttempts > MAX_LOGIN_ATTEMPTS * 10
    ) {
      throw new HttpException(
        'Too many failed attempts — try again in 15 minutes',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.usersRepo
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('u.email = :email', { email })
      .getOne();
    if (!user || !user.passwordHash || !user.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) throw new UnauthorizedException('Invalid credentials');

    // Clear both buckets on success.
    if (ipKey) await this.redis.del(ipKey);
    await this.redis.del(emailKey);
    const tokens = await this.tokens.issuePair(user, {
      deviceId: req.deviceId,
      deviceName: req.deviceName,
      ip: req.ip,
    });
    return { user: this.toSafeUser(user), tokens };
  }

  async sendOtp(phone: string): Promise<{ expiresInSeconds: number }> {
    return this.otp.send(phone);
  }

  async verifyOtp(
    phone: string,
    code: string,
    req: { ip?: string; deviceId: string; deviceName?: string },
  ): Promise<{ user: SafeUser; tokens: TokenPair }> {
    await this.otp.verify(phone, code);
    const user = await this.usersRepo.findOne({ where: { phone } });
    if (!user) {
      throw new BadRequestException(
        'No account found for this phone. Register first via /auth/register.',
      );
    }
    if (!user.isActive) throw new ForbiddenException('Account disabled');
    const tokens = await this.tokens.issuePair(user, {
      deviceId: req.deviceId,
      deviceName: req.deviceName,
      ip: req.ip,
    });
    return { user: this.toSafeUser(user), tokens };
  }

  async googleSignIn(
    idToken: string,
    req: {
      ip?: string;
      deviceId: string;
      deviceName?: string;
      examType?: ExamType;
      formLevel?: number;
      referralCode?: string;
    },
  ): Promise<{ user: SafeUser; tokens: TokenPair; isNew: boolean }> {
    const profile = await this.google.verify(idToken);
    if (!profile.emailVerified) {
      throw new UnauthorizedException('Google email not verified');
    }
    let user = await this.usersRepo.findOne({
      where: { email: profile.email },
    });
    let isNew = false;
    if (!user) {
      if (!req.examType) {
        throw new BadRequestException(
          'examType is required for first-time Google sign-in.',
        );
      }
      // formLevel: required for BECE / WASSCE, MUST be null for NOVDEC.
      const resolvedFormLevel =
        req.examType === ExamType.NOVDEC ? null : (req.formLevel ?? null);
      if (req.examType !== ExamType.NOVDEC && resolvedFormLevel === null) {
        throw new BadRequestException(
          'formLevel is required for BECE / WASSCE first-time Google sign-in.',
        );
      }
      user = this.usersRepo.create({
        fullName: profile.name,
        email: profile.email,
        avatarUrl: profile.picture ?? null,
        authProvider: AuthProvider.GOOGLE,
        role: UserRole.STUDENT,
        examType: req.examType,
        schoolLevel: schoolLevelFor(req.examType),
        formLevel: resolvedFormLevel,
        referralCode: await this.allocateReferralCode(profile.name),
      });
      await this.usersRepo.save(user);
      if (req.referralCode) {
        await this.recordReferralSignup(user, req.referralCode);
        await this.referrals.issueSignupRewards(user.id);
      }
      isNew = true;
    }
    if (!user.isActive) throw new ForbiddenException('Account disabled');
    const tokens = await this.tokens.issuePair(user, {
      deviceId: req.deviceId,
      deviceName: req.deviceName,
      ip: req.ip,
    });
    return { user: this.toSafeUser(user), tokens, isNew };
  }

  async refresh(
    refreshToken: string,
    req: { ip?: string },
  ): Promise<TokenPair> {
    return this.tokens.rotate(refreshToken, { ip: req.ip });
  }

  async logout(
    userId: string,
    accessJti: string | undefined,
    accessExpUnix: number | undefined,
  ): Promise<void> {
    if (accessJti && accessExpUnix) {
      await this.tokens.revokeByAccessJti(accessJti, accessExpUnix);
    }
    await this.tokens.logoutUser(userId);
  }

  async logoutAll(userId: string): Promise<void> {
    await this.tokens.logoutAll(userId);
  }

  async getMe(userId: string): Promise<
    SafeUser & {
      subscription: AuthMeSubscriptionView | null;
    }
  > {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    // Eager-load the plan relation so the mobile gate (`isPro()`) and
    // the settings → subscription screen can read account / level /
    // paymentKind without a second round-trip. The entity's `plan`
    // relation is lazy by default — without `relations: ['plan']` the
    // surfaced JSON would be missing those fields and a paid Plus user
    // would show as Free on the home screen.
    //
    // Per-level scoping: prefer the user's current-level active grant
    // so a stale row on a different level (e.g. Plus on WASSCE while
    // the user is now on NOVDEC) doesn't make `isPro()` return true on
    // a level they're effectively Free on. The level scope keeps the
    // mobile gate in sync with the backend SubscriptionGuard which is
    // already per-level.
    let subscription: Subscription | null = null;
    if (user.examType) {
      subscription = await this.subsRepo
        .createQueryBuilder('s')
        .innerJoin('s.plan', 'p', 'p.level = :level', { level: user.examType })
        .where('s.user_id = :uid', { uid: user.id })
        .andWhere("s.status IN ('active','trial','xp_credited')")
        .andWhere('(s.expires_at IS NULL OR s.expires_at > NOW())')
        .leftJoinAndSelect('s.plan', 'plan')
        .orderBy(
          `CASE p.account WHEN 'pro' THEN 2 WHEN 'plus' THEN 1 ELSE 0 END`,
          'DESC',
        )
        .addOrderBy('s.expires_at', 'DESC', 'NULLS FIRST')
        .getOne();
    }
    // Fallback for "show last subscription state on this level". RESTRICT
    // to the user's current level — returning a cross-level row would
    // make a Plus on WASSCE leak into a NOVDEC user's `isPro()` after
    // they switch profiles. The fallback only matters for inactive rows
    // (the active path above already covers active grants); we want it
    // to be "last subscription on THIS level" not "any subscription".
    if (!subscription && user.examType) {
      subscription = await this.subsRepo
        .createQueryBuilder('s')
        .innerJoin('s.plan', 'p', 'p.level = :level', { level: user.examType })
        .where('s.user_id = :uid', { uid: user.id })
        .leftJoinAndSelect('s.plan', 'plan')
        .orderBy('s.created_at', 'DESC')
        .getOne();
    }
    return {
      ...this.toSafeUser(user),
      subscription: subscription
        ? {
            id: subscription.id,
            userId: subscription.userId,
            planId: subscription.planId,
            billingInterval: subscription.billingInterval,
            provider: subscription.provider,
            providerReference: subscription.providerReference,
            providerSubscriptionId: subscription.providerSubscriptionId,
            providerCustomerId: subscription.providerCustomerId,
            xpRedemptionId: subscription.xpRedemptionId,
            amountGhs: subscription.amountGhs,
            countryCode: subscription.countryCode,
            status: subscription.status,
            startsAt: subscription.startsAt
              ? subscription.startsAt.toISOString()
              : null,
            expiresAt: subscription.expiresAt
              ? subscription.expiresAt.toISOString()
              : null,
            createdAt: subscription.createdAt
              ? subscription.createdAt.toISOString()
              : undefined,
            updatedAt: subscription.updatedAt
              ? subscription.updatedAt.toISOString()
              : undefined,
            account: subscription.plan?.account ?? 'free',
            level: subscription.plan?.level ?? null,
            paymentKind: subscription.plan?.paymentKind ?? null,
          }
        : null,
    };
  }

  /** Public — called from the register screen to validate codes live. */
  async checkReferralCode(code: string): Promise<{ valid: boolean }> {
    const owner = await this.usersRepo.findOne({
      where: { referralCode: code },
      select: ['id'],
    });
    return { valid: Boolean(owner) };
  }

  /** PATCH /auth/me/exam-type — schoolLevel derived from examType. */
  async updateExamType(
    userId: string,
    examType: ExamType,
    formLevel: number | null,
  ): Promise<SafeUser> {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    const before = {
      examType: user.examType,
      formLevel: user.formLevel,
    };
    // NOVDEC has no form — null out the column even if a stale client
    // supplied a value. For BECE / WASSCE the DTO has already validated
    // 1..3, so we can trust the inbound number.
    const resolvedFormLevel =
      examType === ExamType.NOVDEC ? null : (formLevel ?? null);
    if (examType !== ExamType.NOVDEC && resolvedFormLevel === null) {
      throw new BadRequestException('formLevel is required for BECE / WASSCE.');
    }
    user.examType = examType;
    user.schoolLevel = schoolLevelFor(examType);
    user.formLevel = resolvedFormLevel;
    await this.usersRepo.save(user);
    if (
      before.examType !== examType ||
      before.formLevel !== resolvedFormLevel
    ) {
      // Anti-fraud audit trail (spec §6.1: leaderboard farming defense).
      // Without this, a student could flip BECE ↔ WASSCE to dominate a
      // weaker board, then flip back. The controller throttle caps the
      // rate; this log gives admins something to query when reviewing
      // suspicious leaderboard moves.
      const fmt = (lv: number | null) => (lv == null ? 'F-' : `F${lv}`);
      this.logger.log(
        `[audit] user.exam_type.change user=${userId} ` +
          `before=${before.examType}/${fmt(before.formLevel)} ` +
          `after=${examType}/${fmt(resolvedFormLevel)}`,
      );
    }
    return this.toSafeUser(user);
  }

  toSafeUser(user: User): SafeUser {
    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      role: user.role,
      examType: user.examType,
      schoolLevel: user.schoolLevel,
      formLevel: user.formLevel,
      schoolName: user.schoolName,
      region: user.region,
      avatarUrl: user.avatarUrl,
      referralCode: user.referralCode,
      referralQualified: user.referralQualified,
      levelXp: Number(user.levelXp ?? 0),
      spendableXp: Number(user.spendableXp ?? 0),
      currentLevel: user.currentLevel,
      streakDays: user.streakDays,
      longestStreak: user.longestStreak,
      countryCode: user.countryCode,
      isActive: user.isActive,
      createdAt: user.createdAt,
    };
  }
}
