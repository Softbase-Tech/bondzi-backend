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
import { DataSource, Repository } from 'typeorm';
import { hashPassword, verifyPassword } from '../../common/utils/password.util';
import { User } from '../users/entities/user.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { ReferralEvent } from '../referrals/entities/referral-event.entity';
import {
  AuthProvider,
  ExamType,
  Gender,
  SchoolLevel,
  UserRole,
} from '../../common/types/enums';
import { RedisService } from '../../common/redis/redis.service';
import { CacheKeys } from '../../common/utils/cache-keys.util';
import { RegisterDto } from './dto/register.dto';
import {
  canonicalUsername,
  validateUsernameFormat,
} from '../users/username.rules';
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
  /**
   * Public handle used on leaderboards / Hall of Fame. Nullable for
   * accounts created before migration 1940 — mobile prompts those
   * users to back-fill on first session post-deploy.
   */
  username: string | null;
  /**
   * Last time the username was set or changed. NULL = never set. Used
   * by the mobile client to drive the 90-day "next change available in
   * N days" hint without re-querying.
   */
  usernameChangedAt: string | null;
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
  emailVerified: boolean;
  /**
   * Engagement email preferences. Mirrored from the User entity so
   * mobile can render the Settings → Notifications toggles without a
   * second roundtrip. Backend defaults each to `true` at user
   * creation; users opt out per-channel via PATCH /users/me/email-preferences.
   */
  emailWeeklyDigestEnabled: boolean;
  emailStreakNudgesEnabled: boolean;
  emailLevelUpEnabled: boolean;
  emailMarketingEnabled: boolean;
  /**
   * Demographic fields collected at registration (migration 1930).
   * Both nullable: historical accounts created before the columns
   * existed never filled them in, and we keep them readable so the
   * mobile profile screen can render "not set" rather than crash.
   */
  gender: Gender | null;
  /** ISO date string `YYYY-MM-DD` — no time, no zone. */
  dateOfBirth: string | null;
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
    private readonly dataSource: DataSource,
    private readonly subscriptionsService: SubscriptionsService,
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

    // Username — DTO decorators have already enforced length + charset.
    // Service runs the reserved-word check and case-insensitive
    // uniqueness so the same rejection surfaces here as on the
    // /auth/username/available pre-flight.
    const fmt = validateUsernameFormat(dto.username);
    if (!fmt.ok) {
      throw new BadRequestException(fmt.message ?? 'Invalid username.');
    }
    const usernameCanonical = canonicalUsername(dto.username);
    const usernameTaken = await this.usersRepo
      .createQueryBuilder('u')
      .select(['u.id'])
      .where('lower(u.username) = :canonical', {
        canonical: usernameCanonical,
      })
      .getOne();
    if (usernameTaken) {
      throw new ConflictException('Username already taken');
    }

    // Date-of-birth sanity: must be in the past + within plausible
    // student-age bounds. Only checked when supplied (the column is
    // nullable for backwards-compat); DTO ensures the value is a
    // strict ISO date string before we get here.
    if (dto.dateOfBirth) {
      this.assertPlausibleDateOfBirth(dto.dateOfBirth);
    }

    // Email OTP verification — proves the signup device controls the
    // email BEFORE the user row is created. Mobile signups always
    // include this; phone-only backend signups don't have an email
    // so we skip. If verification fails, the OTP is consumed by
    // OtpService.verifyEmail throwing — the caller has to /send a
    // fresh code to retry.
    let emailOtpVerified = false;
    if (dto.email && dto.emailOtp) {
      await this.otp.verifyEmail(dto.email, dto.emailOtp);
      emailOtpVerified = true;
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
      username: dto.username.trim(),
      usernameChangedAt: new Date(),
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
      emailUnsubscribeToken: randomBytes(24).toString('hex'),
      gender: dto.gender ?? null,
      dateOfBirth: dto.dateOfBirth ?? null,
      // Email OTP proved the user controls the address — set verified
      // immediately so the in-app banner doesn't show and we skip the
      // verify-link email below.
      emailVerifiedAt: emailOtpVerified ? new Date() : null,
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

    // Spec §2.3 step 6: welcome push + email (+ verification for email
    // signups without OTP — OTP-verified signups don't need the
    // verify-link email since `email_verified_at` is already set).
    await this.sendWelcomeOnboarding(user);
    if (user.email && !emailOtpVerified) {
      await this.sendEmailVerification(user).catch(() => void 0);
    }

    return { user: this.toSafeUser(user), tokens };
  }

  /**
   * Reject dates of birth that are nonsensical for our user base.
   * The mobile registration form should already catch these client-side
   * — this is the server-side belt to keep bad analytics out of the DB.
   */
  private assertPlausibleDateOfBirth(iso: string): void {
    const parsed = new Date(`${iso}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('dateOfBirth must be a valid ISO date');
    }
    const now = Date.now();
    // Anyone younger than 8 likely isn't a real student; anyone
    // older than 100 is almost certainly a typo. These are guard
    // rails, not legal age gates.
    const eightYearsAgo = now - 8 * 365.25 * 24 * 60 * 60 * 1000;
    const hundredYearsAgo = now - 100 * 365.25 * 24 * 60 * 60 * 1000;
    if (parsed.getTime() > eightYearsAgo) {
      throw new BadRequestException(
        'dateOfBirth: students must be at least 8 years old',
      );
    }
    if (parsed.getTime() < hundredYearsAgo) {
      throw new BadRequestException(
        'dateOfBirth: please check the year you entered',
      );
    }
  }

  /**
   * Password login. Accepts EITHER `email` or `phone` — controllers
   * must supply exactly one (DTO enforces this). The chosen
   * identifier is used both for the per-identifier lockout bucket
   * and the user lookup; the password verification path is
   * identical for both.
   *
   * Phone-OTP login was removed at launch: OTP is now reserved for
   * password reset. Existing phone-only users continue to log in
   * via the password they set at registration.
   */
  async login(
    identifier: { email?: string; phone?: string },
    password: string,
    req: { ip?: string; deviceId: string; deviceName?: string },
  ): Promise<{ user: SafeUser; tokens: TokenPair }> {
    const email = identifier.email?.trim().toLowerCase();
    const phone = identifier.phone?.trim();
    if (!email && !phone) {
      throw new BadRequestException('Either email or phone is required');
    }
    // Stable bucket key — lowercased email or raw phone. The
    // attempt-rate-limit is per-identifier so a brute-force on
    // phone:+233xx doesn't lock email:bob@x.com (and vice versa).
    const idBucket = email ? `email:${email}` : `phone:${phone ?? ''}`;
    // CRITICAL: two independent lockout buckets — by IP AND by identifier.
    // The previous shape used `ip || email`, so once `trust proxy` was
    // fixed, every legitimate user behind the same NAT (a school's
    // internet share) collided with each other; conversely, an attacker
    // rotating IPs trivially evaded the per-identifier count. Both
    // buckets get tripped before we let the request through.
    const ipKey = req.ip ? CacheKeys.loginAttempts(`ip:${req.ip}`) : null;
    const idKey = CacheKeys.loginAttempts(idBucket);
    const ipAttempts = ipKey
      ? await this.redis.incr(ipKey, LOGIN_LOCKOUT_TTL_SECONDS)
      : 0;
    const idAttempts = await this.redis.incr(idKey, LOGIN_LOCKOUT_TTL_SECONDS);
    if (
      idAttempts > MAX_LOGIN_ATTEMPTS ||
      // IP bucket is wider so a single bad actor doesn't lock the whole
      // NAT — 10× the per-identifier cap.
      ipAttempts > MAX_LOGIN_ATTEMPTS * 10
    ) {
      throw new HttpException(
        'Too many failed attempts — try again in 15 minutes',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const qb = this.usersRepo
      .createQueryBuilder('u')
      .addSelect('u.passwordHash');
    if (email) qb.where('u.email = :email', { email });
    else qb.where('u.phone = :phone', { phone });
    const user = await qb.getOne();
    if (!user || !user.passwordHash || !user.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) throw new UnauthorizedException('Invalid credentials');

    // Clear both buckets on success.
    if (ipKey) await this.redis.del(ipKey);
    await this.redis.del(idKey);
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
        emailVerifiedAt: new Date(),
        emailUnsubscribeToken: randomBytes(24).toString('hex'),
      });
      await this.usersRepo.save(user);
      if (req.referralCode) {
        await this.recordReferralSignup(user, req.referralCode);
        await this.referrals.issueSignupRewards(user.id);
      }
      isNew = true;
      await this.sendWelcomeOnboarding(user).catch(() => void 0);
    }
    if (!user.isActive) throw new ForbiddenException('Account disabled');
    const tokens = await this.tokens.issuePair(user, {
      deviceId: req.deviceId,
      deviceName: req.deviceName,
      ip: req.ip,
    });
    return { user: this.toSafeUser(user), tokens, isNew };
  }

  /**
   * Pre-registration email OTP — issues a 6-digit code via email.
   * Anti-enumeration: always returns `{ expiresInSeconds }` whether
   * or not the address is already registered, so an attacker can't
   * probe for existing accounts via the OTP endpoint. The collision
   * check happens later at /auth/register, where a duplicate fails
   * with ConflictException AFTER the OTP has been verified.
   */
  async sendEmailOtp(
    email: string,
    recipientName?: string,
  ): Promise<{ expiresInSeconds: number }> {
    return this.otp.sendEmail(email, recipientName);
  }

  async requestEmailVerification(userId: string): Promise<{ sent: boolean }> {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user?.email) {
      throw new BadRequestException('No email on file');
    }
    if (user.emailVerifiedAt) {
      return { sent: false };
    }
    await this.sendEmailVerification(user);
    return { sent: true };
  }

  async verifyEmail(token: string): Promise<{ verified: boolean }> {
    const consumed = await this.mail.consumeEmailVerificationToken(token);
    if (!consumed) {
      throw new BadRequestException('Invalid or expired verification link');
    }
    const user = await this.usersRepo.findOne({
      where: { id: consumed.userId },
    });
    if (!user) {
      throw new BadRequestException('Invalid or expired verification link');
    }
    if (!user.emailVerifiedAt) {
      user.emailVerifiedAt = new Date();
      await this.usersRepo.save(user);
    }
    return { verified: true };
  }

  /** Always returns success — do not leak whether the email exists. */
  /**
   * Begin a password reset. Accepts either an email (sends the
   * standard reset link) OR a phone (sends a 6-digit SMS OTP). The
   * response is anti-enumeration — always `{ ok: true }` regardless
   * of whether the identifier matches a user, so callers can't probe
   * for registered accounts.
   *
   * Rate-limited per-identifier — phone bucket is the existing OTP
   * send bucket inside OtpService (3 / 10 min); email bucket lives
   * here (5 / 15 min).
   */
  async forgotPassword(input: {
    email?: string;
    phone?: string;
  }): Promise<{ ok: true }> {
    if (input.email) {
      const normalized = input.email.toLowerCase().trim();
      const rateKey = CacheKeys.forgotPasswordRate(normalized);
      const attempts = await this.redis.incr(rateKey, 15 * 60);
      if (attempts > 5) {
        return { ok: true };
      }

      const user = await this.usersRepo
        .createQueryBuilder('u')
        .addSelect('u.passwordHash')
        .where('lower(u.email) = lower(:email)', { email: normalized })
        .getOne();

      if (!user?.email || !user.passwordHash || !user.isActive) {
        return { ok: true };
      }

      const token = await this.mail.createPasswordResetToken(user.id);
      const resetUrl = this.mail.buildResetUrl(token);
      await this.mail.send(
        MailEvent.PASSWORD_RESET,
        user.email,
        {
          recipientName: user.fullName.split(' ')[0],
          resetUrl,
          expiresInMinutes: 60,
        },
        { userId: user.id },
      );
      return { ok: true };
    }

    if (input.phone) {
      // OtpService.send handles its own throttling (3 sends per
      // phone per 10 min) AND short-circuits the SMS dispatch if
      // the rate is exceeded. We always return `{ ok: true }` —
      // anti-enumeration — but only actually generate+send the
      // code when the phone resolves to an active user with a
      // password. Sending OTPs to unregistered numbers would
      // burn SMS budget on attackers iterating the phone space.
      const user = await this.usersRepo
        .createQueryBuilder('u')
        .addSelect('u.passwordHash')
        .where('u.phone = :phone', { phone: input.phone.trim() })
        .getOne();
      if (user?.passwordHash && user.isActive) {
        // Swallow rate-limit / SMS-provider errors — the caller
        // mustn't be able to distinguish "you exist + we sent SMS"
        // from "you don't exist" from "we couldn't send".
        await this.otp
          .send(input.phone.trim())
          .catch((err) =>
            this.logger.warn(
              `[forgot-password] SMS dispatch failed for phone bucket: ${(err as Error).message}`,
            ),
          );
      }
      return { ok: true };
    }

    throw new BadRequestException('Either email or phone is required');
  }

  /**
   * Complete a password reset. Two shapes accepted:
   *   1. Email-link reset: `{ token, password }` — token is the
   *      cryptographically-secure value embedded in the reset email
   *      URL.
   *   2. Phone-OTP reset: `{ phone, otp, password }` — the OTP
   *      came from the SMS sent by `forgotPassword({phone})`.
   */
  async resetPassword(input: {
    token?: string;
    phone?: string;
    otp?: string;
    password: string;
  }): Promise<{ ok: true }> {
    let userId: string | null = null;

    if (input.token) {
      const consumed = await this.mail.consumePasswordResetToken(input.token);
      if (!consumed) {
        throw new BadRequestException('Invalid or expired reset link');
      }
      userId = consumed.userId;
    } else if (input.phone && input.otp) {
      // OTPService.verify is single-use + atomic — the same code
      // can't be replayed for a second reset.
      await this.otp.verify(input.phone.trim(), input.otp);
      const user = await this.usersRepo.findOne({
        where: { phone: input.phone.trim() },
      });
      if (!user || !user.isActive) {
        throw new BadRequestException('Invalid or expired reset code');
      }
      userId = user.id;
    } else {
      throw new BadRequestException(
        'Provide either an email-reset token or phone + otp',
      );
    }

    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user || !user.isActive) {
      throw new BadRequestException('Invalid or expired reset request');
    }
    user.passwordHash = await hashPassword(input.password);
    await this.usersRepo.save(user);
    // Log out every active session so a stolen-token actor can't
    // continue using a previously-issued access token.
    await this.tokens.logoutAll(user.id);
    return { ok: true };
  }

  private async sendWelcomeOnboarding(user: User): Promise<void> {
    await this.notifications
      .send({
        userId: user.id,
        channel: NotificationChannel.PUSH,
        title: `Welcome to Bondzi, ${user.fullName.split(' ')[0]}!`,
        body: 'Answer your first question to start earning XP.',
        data: { type: 'welcome' },
      })
      .catch(() => void 0);

    if (user.email) {
      await this.mail.send(
        MailEvent.WELCOME,
        user.email,
        {
          recipientName: user.fullName.split(' ')[0],
          examType: user.examType.toUpperCase(),
        },
        { userId: user.id },
      );
    }
  }

  private async sendEmailVerification(user: User): Promise<void> {
    if (!user.email || user.emailVerifiedAt) return;
    const token = await this.mail.createEmailVerificationToken(user.id);
    const verificationUrl = this.mail.buildVerifyUrl(token);
    await this.mail.send(
      MailEvent.EMAIL_VERIFICATION,
      user.email,
      {
        recipientName: user.fullName.split(' ')[0],
        verificationUrl,
        expiresInMinutes: 24 * 60,
      },
      { userId: user.id },
    );
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

  /**
   * PATCH /auth/me/exam-type — schoolLevel derived from examType.
   *
   * The access token bakes in the user's `examType` claim, which the
   * SubscriptionGuard reads directly to gate per-level paywalls. A
   * change to examType MUST invalidate the per-level entitlement
   * cache AND rotate the token pair so the next request reflects the
   * new level immediately. Without rotation the user lives on stale
   * claims for up to the JWT TTL (15 min); without cache
   * invalidation, the freshly-issued token reads back into a stale
   * Redis entry keyed against the old level.
   *
   * `deviceId` is required when the call originates from a logged-in
   * mobile session (i.e. always). It identifies which DeviceSession
   * to rotate; without it the rotation would orphan the user's
   * session.
   */
  async updateExamType(
    userId: string,
    examType: ExamType,
    formLevel: number | null,
    rotation: {
      deviceId: string;
      ip?: string;
      deviceName?: string;
      /** Pre-rotation JWT jti — revoked immediately after the new pair is issued. */
      currentJti?: string;
      /** Pre-rotation JWT exp (unix seconds) — sets the revocation TTL. */
      currentExp?: number;
    } | null,
  ): Promise<{ user: SafeUser; tokens: TokenPair | null }> {
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
    // Subject selections are scoped to the OLD exam type — a WASSCE
    // student switching to BECE was studying Core Maths SHS, not Core
    // Maths JHS, and those rows would now point at subjects with the
    // wrong examType. Wipe them so the user lands on the new level
    // with a clean "no preference, show everything" default; they can
    // re-curate via Settings → Subjects.
    const examTypeChanged = before.examType !== examType;
    if (examTypeChanged) {
      await this.dataSource
        .createQueryBuilder()
        .delete()
        .from('user_subjects')
        .where('user_id = :uid', { uid: userId })
        .execute();

      // Anti-leaderboard-farming defense: a user could otherwise grind
      // to the top of BECE on Monday, switch to WASSCE on Tuesday and
      // accumulate a SECOND bucket, then flip back and continue the
      // BECE grind — the throttle limits switch frequency but does
      // nothing about persisted leaderboard rows. Wipe the OLD
      // exam_type's leaderboard entries for this user so they
      // re-enter the new board at zero. The audit log entry below
      // remains as the forensic trail.
      await this.dataSource
        .createQueryBuilder()
        .delete()
        .from('leaderboard_entries')
        .where('user_id = :uid AND exam_type = :prev', {
          uid: userId,
          prev: before.examType,
        })
        .execute()
        .catch((err) =>
          this.logger.error(
            `[exam-type] failed to wipe leaderboard_entries for user=${userId} prev=${before.examType}: ${(err as Error).message}`,
          ),
        );
    }
    if (examTypeChanged || before.formLevel !== resolvedFormLevel) {
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

    // Entitlements are per-(user, level) in Redis. The freshly-issued
    // token's claim will be read against this cache on the next
    // request — purge ALL per-level entries + the legacy cross-level
    // status key so the guard re-resolves against the live DB.
    if (examTypeChanged) {
      await this.subscriptionsService
        .invalidateCache(userId)
        .catch((err) =>
          this.logger.error(
            `[exam-type] cache invalidation failed for user=${userId}: ${(err as Error).message}`,
          ),
        );
    }

    // Token rotation on level change. The access token bakes the
    // examType + the resolved per-level entitlement at issue time —
    // both go stale on a level switch. Issue a fresh pair so the
    // mobile carries the right claims from the very next request,
    // closing the up-to-15-minute window where the old claim would
    // still be honoured.
    //
    // We only rotate when the level actually changed AND we have a
    // deviceId to bind the new session to (mobile flows always supply
    // it via the X-Device-ID header). Tokens=null when no rotation
    // happened so the caller can decide whether to update local
    // storage.
    let tokens: TokenPair | null = null;
    if (examTypeChanged && rotation?.deviceId) {
      tokens = await this.tokens
        .issuePair(user, {
          deviceId: rotation.deviceId,
          ip: rotation.ip,
          deviceName: rotation.deviceName,
        })
        .catch((err) => {
          this.logger.error(
            `[exam-type] token rotation failed for user=${userId}: ${(err as Error).message}`,
          );
          return null;
        });

      // Revoke the PRE-rotation access token so any cached copy
      // (in-flight retry, background sync, push handler that woke
      // just before this call) is rejected by JwtStrategy on its
      // next use. Without this the old token's `did` claim still
      // matches the (now re-bound) DeviceSession AND it isn't on
      // the revoked-set — so it could carry the stale `examType`
      // claim for up to the access TTL (~15 min), defeating the
      // very rotation we just did.
      //
      // Best-effort: a Redis hiccup here doesn't roll back the
      // exam-type change — the new tokens are still issued and
      // bound, so the mobile gets the right claims immediately;
      // only the narrow stale-token-replay window stays open.
      if (tokens && rotation.currentJti && rotation.currentExp) {
        await this.tokens
          .revokeByAccessJti(rotation.currentJti, rotation.currentExp)
          .catch((err) =>
            this.logger.error(
              `[exam-type] failed to revoke pre-rotation jti=${rotation.currentJti}: ${(err as Error).message}`,
            ),
          );
      }
    }

    return { user: this.toSafeUser(user), tokens };
  }

  toSafeUser(user: User): SafeUser {
    return {
      id: user.id,
      fullName: user.fullName,
      username: user.username ?? null,
      usernameChangedAt: user.usernameChangedAt
        ? user.usernameChangedAt.toISOString()
        : null,
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
      emailVerified: Boolean(user.emailVerifiedAt),
      emailWeeklyDigestEnabled: user.emailWeeklyDigestEnabled,
      emailStreakNudgesEnabled: user.emailStreakNudgesEnabled,
      emailLevelUpEnabled: user.emailLevelUpEnabled,
      emailMarketingEnabled: user.emailMarketingEnabled,
      gender: user.gender ?? null,
      dateOfBirth: user.dateOfBirth ?? null,
      createdAt: user.createdAt,
    };
  }
}
