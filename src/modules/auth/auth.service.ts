import { randomBytes } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
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
  formLevel: number;
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

@Injectable()
export class AuthService {
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
   */
  private async recordReferralSignup(
    newUser: User,
    referralCode: string,
  ): Promise<void> {
    const referrer = await this.usersRepo.findOne({
      where: { referralCode },
    });
    if (!referrer || referrer.id === newUser.id) return;
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

    const user = this.usersRepo.create({
      fullName: dto.fullName,
      email: dto.email ?? null,
      phone: dto.phone ?? null,
      passwordHash,
      authProvider:
        dto.authProvider ??
        (dto.phone ? AuthProvider.PHONE : AuthProvider.EMAIL),
      examType: dto.examType,
      schoolLevel: schoolLevelFor(dto.examType),
      formLevel: dto.formLevel,
      referralCode: await this.allocateReferralCode(dto.fullName),
      schoolName: dto.schoolName ?? null,
      region: dto.region ?? null,
      role: UserRole.STUDENT,
    });
    await this.usersRepo.save(user);

    if (dto.referralCode) {
      await this.recordReferralSignup(user, dto.referralCode);
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
        title: `Welcome to PassMaster, ${user.fullName.split(' ')[0]}!`,
        body: 'Answer your first question to start earning XP.',
        data: { type: 'welcome' },
      })
      .catch(() => void 0);

    return { user: this.toSafeUser(user), tokens };
  }

  async login(
    email: string,
    password: string,
    req: { ip?: string; deviceId: string; deviceName?: string },
  ): Promise<{ user: SafeUser; tokens: TokenPair }> {
    const ipKey = CacheKeys.loginAttempts(req.ip ?? email);
    const attempts = await this.redis.incr(ipKey, LOGIN_LOCKOUT_TTL_SECONDS);
    if (attempts > MAX_LOGIN_ATTEMPTS) {
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

    await this.redis.del(ipKey);
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
      if (!req.examType || !req.formLevel) {
        throw new BadRequestException(
          'examType and formLevel are required for first-time Google sign-in.',
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
        formLevel: req.formLevel,
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

  async getMe(
    userId: string,
  ): Promise<SafeUser & { subscription: Subscription | null }> {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    const subscription = await this.subsRepo.findOne({
      where: { userId: user.id },
      order: { createdAt: 'DESC' },
    });
    return { ...this.toSafeUser(user), subscription };
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
    formLevel: number,
  ): Promise<SafeUser> {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    user.examType = examType;
    user.schoolLevel = schoolLevelFor(examType);
    user.formLevel = formLevel;
    await this.usersRepo.save(user);
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
