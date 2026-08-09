import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuthService } from './auth.service';
import { TokensService } from './tokens.service';
import { OtpService } from './otp.service';
import { GoogleOAuthService } from './google-oauth.service';
import { ReferralsService } from '../referrals/referrals.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RedisService } from '../../common/redis/redis.service';
import { User } from '../users/entities/user.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { ReferralEvent } from '../referrals/entities/referral-event.entity';
import {
  AuthProvider,
  ExamType,
  SchoolLevel,
  UserRole,
} from '../../common/types/enums';
import * as passwordUtil from '../../common/utils/password.util';

/**
 * AuthService is the security-critical entry point — login lockout, password
 * verify, OTP, Google sign-in, refresh-token rotation all live here. These
 * tests focus on the paths a bug would let through (silent auth bypass,
 * lockout skipped, missing fields accepted, duplicate accounts) rather than
 * exhaustively asserting happy-path return shapes.
 */

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    fullName: 'Jane Doe',
    email: 'jane@example.com',
    phone: null,
    passwordHash: 'argon2-hash',
    authProvider: AuthProvider.EMAIL,
    role: UserRole.STUDENT,
    examType: ExamType.WASSCE,
    schoolLevel: SchoolLevel.SHS,
    formLevel: 3,
    schoolName: null,
    region: null,
    avatarUrl: null,
    referralCode: 'PM-AAAA-JAN',
    referralQualified: false,
    referredBy: null,
    levelXp: 0 as unknown as number,
    spendableXp: 0 as unknown as number,
    currentLevel: 1,
    streakDays: 0,
    longestStreak: 0,
    countryCode: 'GH',
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as User;
}

describe('AuthService', () => {
  let service: AuthService;
  let usersRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
    manager: { query: jest.Mock };
  };
  let subsRepo: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let referralsRepo: { insert: jest.Mock };
  let tokens: {
    issuePair: jest.Mock;
    rotate: jest.Mock;
    revokeByAccessJti: jest.Mock;
    logoutUser: jest.Mock;
    logoutAll: jest.Mock;
  };
  let otp: { send: jest.Mock; verify: jest.Mock };
  let google: { verify: jest.Mock };
  let redis: { incr: jest.Mock; del: jest.Mock };
  let referrals: { issueSignupRewards: jest.Mock };
  let notifications: { send: jest.Mock };
  let mail: { send: jest.Mock };
  let subsService: { invalidateCache: jest.Mock };

  beforeEach(async () => {
    usersRepo = {
      findOne: jest.fn(),
      create: jest.fn((o) => o),
      save: jest.fn(async (u) => u),
      update: jest.fn(),
      createQueryBuilder: jest.fn(),
      // Used by `recordReferralSignup` for the device-collision check —
      // default to "no overlap" so existing tests behave as before. The
      // referral-fraud test below overrides this to assert short-circuit.
      manager: { query: jest.fn().mockResolvedValue([]) },
    };
    subsRepo = { findOne: jest.fn(), createQueryBuilder: jest.fn() };
    referralsRepo = { insert: jest.fn() };
    tokens = {
      issuePair: jest.fn(async () => ({
        accessToken: 'a',
        refreshToken: 'r',
        accessExpiresIn: 900,
        refreshExpiresIn: 2_592_000,
      })),
      rotate: jest.fn(),
      revokeByAccessJti: jest.fn(),
      logoutUser: jest.fn(),
      logoutAll: jest.fn(),
    };
    otp = { send: jest.fn(), verify: jest.fn() };
    google = { verify: jest.fn() };
    redis = { incr: jest.fn(async () => 1), del: jest.fn() };
    referrals = { issueSignupRewards: jest.fn() };
    notifications = { send: jest.fn(async () => undefined) };
    mail = { send: jest.fn(async () => undefined) };

    const { MailService } = await import('../mail/mail.service');
    const { DataSource } = await import('typeorm');
    const { SubscriptionsService } =
      await import('../subscriptions/subscriptions.service');
    subsService = {
      invalidateCache: jest.fn().mockResolvedValue(undefined),
    };
    // The updateExamType path uses dataSource.createQueryBuilder() to
    // wipe stale `user_subjects` rows when the level changes. Stub the
    // chain so the spec's login / OTP paths (which don't exercise
    // exam-type writes) don't trip on a missing DataSource. The
    // exam-type spec block sets up its own per-test expectations on
    // top of this default.
    const dataSource = {
      createQueryBuilder: jest.fn().mockReturnValue({
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: getRepositoryToken(Subscription), useValue: subsRepo },
        { provide: getRepositoryToken(ReferralEvent), useValue: referralsRepo },
        { provide: TokensService, useValue: tokens },
        { provide: OtpService, useValue: otp },
        { provide: GoogleOAuthService, useValue: google },
        { provide: RedisService, useValue: redis },
        { provide: ReferralsService, useValue: referrals },
        { provide: NotificationsService, useValue: notifications },
        { provide: MailService, useValue: mail },
        { provide: DataSource, useValue: dataSource },
        { provide: SubscriptionsService, useValue: subsService },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  // -------------------------- login --------------------------

  describe('login', () => {
    function stubFindUserByEmail(user: User | null) {
      const qb = {
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(user),
      };
      usersRepo.createQueryBuilder.mockReturnValue(qb);
      return qb;
    }

    it('locks the account after MAX_LOGIN_ATTEMPTS', async () => {
      redis.incr.mockResolvedValueOnce(6); // > 5
      await expect(
        service.login({ email: 'jane@example.com' }, 'pw', { deviceId: 'd1' }),
      ).rejects.toBeInstanceOf(HttpException);
      // Should not even reach the DB on a locked-out IP.
      expect(usersRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('rejects unknown email with Unauthorized (does not leak existence)', async () => {
      stubFindUserByEmail(null);
      await expect(
        service.login({ email: 'nobody@example.com' }, 'pw', {
          deviceId: 'd1',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a wrong password', async () => {
      stubFindUserByEmail(makeUser());
      jest.spyOn(passwordUtil, 'verifyPassword').mockResolvedValueOnce(false);
      await expect(
        service.login({ email: 'jane@example.com' }, 'bad', { deviceId: 'd1' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(tokens.issuePair).not.toHaveBeenCalled();
    });

    it('rejects an inactive account', async () => {
      stubFindUserByEmail(makeUser({ isActive: false }));
      jest.spyOn(passwordUtil, 'verifyPassword').mockResolvedValueOnce(true);
      await expect(
        service.login({ email: 'jane@example.com' }, 'pw', { deviceId: 'd1' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('clears BOTH lockout counters (per-IP and per-email) on success', async () => {
      // The lockout buckets are split — per-IP AND per-email — so an
      // attacker rotating IPs can't evade the per-email count and a
      // shared NAT can't lock out an entire school. Both must clear
      // on a successful login.
      stubFindUserByEmail(makeUser());
      jest.spyOn(passwordUtil, 'verifyPassword').mockResolvedValueOnce(true);
      const result = await service.login({ email: 'jane@example.com' }, 'pw', {
        deviceId: 'd1',
        ip: '1.2.3.4',
      });
      expect(redis.del).toHaveBeenCalledTimes(2);
      expect(tokens.issuePair).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-1' }),
        expect.objectContaining({ deviceId: 'd1', ip: '1.2.3.4' }),
      );
      expect(result.user.email).toBe('jane@example.com');
      expect(
        (result.user as unknown as { passwordHash?: string }).passwordHash,
      ).toBeUndefined();
    });
  });

  // ------------------------- register -------------------------

  describe('register', () => {
    const baseDto = {
      fullName: 'Kofi Mensah',
      username: 'kofimensah',
      email: 'kofi@example.com',
      password: 'StrongPass123',
      examType: ExamType.WASSCE,
      formLevel: 3 as 1 | 2 | 3,
      deviceId: 'd1',
    };

    it('rejects when neither email nor phone is provided', async () => {
      await expect(
        service.register({ ...baseDto, email: undefined } as never, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when email is already taken', async () => {
      usersRepo.findOne.mockResolvedValueOnce(makeUser());
      await expect(
        service.register(baseDto as never, {}),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects when deviceId is missing (belt + braces with controller)', async () => {
      usersRepo.findOne.mockResolvedValue(null);
      // Username uniqueness check uses createQueryBuilder — return a
      // chain that resolves to "no collision" so the path reaches the
      // controller's deviceId guard.
      const qb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      };
      usersRepo.createQueryBuilder.mockReturnValue(qb);
      jest.spyOn(passwordUtil, 'hashPassword').mockResolvedValueOnce('hash');
      await expect(
        service.register({ ...baseDto, deviceId: undefined } as never, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    // Builds a fresh username-uniqueness queryBuilder mock that
    // resolves to `null` (i.e. the handle is free). Register also uses
    // createQueryBuilder for the referral-code clash check inside
    // allocateReferralCode, so plumb both off the same factory.
    const mockUsernameFree = () => {
      const qb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      };
      usersRepo.createQueryBuilder.mockReturnValue(qb);
      return qb;
    };

    it('issues tokens and a welcome notification on success', async () => {
      usersRepo.findOne.mockResolvedValue(null);
      mockUsernameFree();
      jest.spyOn(passwordUtil, 'hashPassword').mockResolvedValueOnce('hash');
      const out = await service.register(baseDto as never, { ip: '1.1.1.1' });
      expect(tokens.issuePair).toHaveBeenCalled();
      expect(notifications.send).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining('Welcome') }),
      );
      expect(out.user.fullName).toBe('Kofi Mensah');
    });

    it('records the referral signup and triggers reward issuance', async () => {
      usersRepo.findOne
        .mockResolvedValueOnce(null) // email check
        .mockResolvedValueOnce(null) // referral-code clash check
        .mockResolvedValueOnce(
          makeUser({ id: 'ref-1', referralCode: 'PM-XXXX-MEN' }),
        ); // referrer lookup
      mockUsernameFree();
      jest.spyOn(passwordUtil, 'hashPassword').mockResolvedValueOnce('hash');
      await service.register(
        { ...baseDto, referralCode: 'PM-XXXX-MEN' } as never,
        {},
      );
      expect(referralsRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          referrerId: 'ref-1',
          referralCode: 'PM-XXXX-MEN',
        }),
      );
      expect(referrals.issueSignupRewards).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------- otp + google --------------------------

  describe('verifyOtp', () => {
    it('rejects when no user with that phone exists', async () => {
      otp.verify.mockResolvedValueOnce(undefined);
      usersRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.verifyOtp('+233500000000', '1234', { deviceId: 'd1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an inactive account even with a valid code', async () => {
      otp.verify.mockResolvedValueOnce(undefined);
      usersRepo.findOne.mockResolvedValueOnce(makeUser({ isActive: false }));
      await expect(
        service.verifyOtp('+233500000000', '1234', { deviceId: 'd1' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('googleSignIn', () => {
    it('rejects an unverified Google email', async () => {
      google.verify.mockResolvedValueOnce({
        email: 'x@example.com',
        emailVerified: false,
        name: 'X',
      });
      await expect(
        service.googleSignIn('idtoken', { deviceId: 'd1' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('requires examType and formLevel on first-time signup', async () => {
      google.verify.mockResolvedValueOnce({
        email: 'new@example.com',
        emailVerified: true,
        name: 'New User',
      });
      usersRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.googleSignIn('idtoken', { deviceId: 'd1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('signs an existing user in without re-creating them', async () => {
      google.verify.mockResolvedValueOnce({
        email: 'jane@example.com',
        emailVerified: true,
        name: 'Jane',
      });
      usersRepo.findOne.mockResolvedValueOnce(makeUser());
      const out = await service.googleSignIn('idtoken', { deviceId: 'd1' });
      expect(out.isNew).toBe(false);
      expect(usersRepo.save).not.toHaveBeenCalled();
      expect(tokens.issuePair).toHaveBeenCalled();
    });
  });

  // --------------------------- misc ---------------------------

  describe('refresh / logout', () => {
    it('delegates refresh to TokensService.rotate', async () => {
      tokens.rotate.mockResolvedValueOnce({ accessToken: 'A' });
      const out = await service.refresh('rt', { ip: '1.1.1.1' });
      expect(tokens.rotate).toHaveBeenCalledWith('rt', { ip: '1.1.1.1' });
      expect(out).toEqual({ accessToken: 'A' });
    });

    it('revokes the access jti on logout when both jti and exp are supplied', async () => {
      await service.logout('user-1', 'jti-1', 999, 'd1');
      expect(tokens.revokeByAccessJti).toHaveBeenCalledWith('jti-1', 999);
      // Per-device logout: only this device's session is closed.
      expect(tokens.logoutUser).toHaveBeenCalledWith('user-1', 'd1');
    });

    it('logout skips access-jti revocation when jti is missing', async () => {
      await service.logout('user-1', undefined, undefined, 'd1');
      expect(tokens.revokeByAccessJti).not.toHaveBeenCalled();
      expect(tokens.logoutUser).toHaveBeenCalledWith('user-1', 'd1');
    });

    it('logout without a deviceId falls back to logout-everywhere semantics', async () => {
      // Legacy access tokens without a `did` claim still work — the
      // safer default is a full sign-out (delegated inside
      // logoutUser) rather than a silent no-op.
      await service.logout('user-1', 'jti-1', 999, undefined);
      expect(tokens.logoutUser).toHaveBeenCalledWith('user-1', undefined);
    });
  });

  describe('getMe / checkReferralCode / updateExamType', () => {
    it('getMe throws Unauthorized when user is missing', async () => {
      usersRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.getMe('user-1')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('getMe attaches the current-level subscription when present', async () => {
      usersRepo.findOne.mockResolvedValueOnce(makeUser());
      // First attempt: per-level query-builder lookup. Returns the
      // active WASSCE row.
      const qb = {
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getOne: jest
          .fn()
          .mockResolvedValueOnce({ id: 'sub-1' } as Subscription),
      };
      subsRepo.createQueryBuilder.mockReturnValueOnce(qb);
      const out = await service.getMe('user-1');
      expect(out.subscription?.id).toBe('sub-1');
    });

    it('getMe falls back to the latest level-scoped row when no current-level grant exists', async () => {
      usersRepo.findOne.mockResolvedValueOnce(makeUser());
      // Active-grant lookup returns null (no active grant on user's level).
      const activeQb = {
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValueOnce(null),
      };
      // Fallback lookup returns the latest level-scoped row.
      const fallbackQb = {
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getOne: jest
          .fn()
          .mockResolvedValueOnce({ id: 'sub-old' } as Subscription),
      };
      subsRepo.createQueryBuilder
        .mockReturnValueOnce(activeQb)
        .mockReturnValueOnce(fallbackQb);
      const out = await service.getMe('user-1');
      expect(out.subscription?.id).toBe('sub-old');
    });

    it('checkReferralCode reports valid when the code owner exists', async () => {
      usersRepo.findOne.mockResolvedValueOnce({ id: 'x' });
      expect(await service.checkReferralCode('PM-ANY')).toEqual({
        valid: true,
      });
    });

    it('checkReferralCode reports invalid when the code is unknown', async () => {
      usersRepo.findOne.mockResolvedValueOnce(null);
      expect(await service.checkReferralCode('PM-UNKNOWN')).toEqual({
        valid: false,
      });
    });

    it('updateExamType derives schoolLevel from examType, invalidates cache, and rotates tokens', async () => {
      const user = makeUser({
        examType: ExamType.WASSCE,
        schoolLevel: SchoolLevel.SHS,
      });
      usersRepo.findOne.mockResolvedValueOnce(user);
      const out = await service.updateExamType('user-1', ExamType.BECE, 3, {
        deviceId: 'dev-1',
        ip: '1.2.3.4',
      });
      expect(out.user.examType).toBe(ExamType.BECE);
      expect(out.user.schoolLevel).toBe(SchoolLevel.JHS);
      expect(usersRepo.save).toHaveBeenCalled();
      // Cache invalidation MUST happen so the rotated token reads
      // against fresh per-level entitlement state.
      expect(subsService.invalidateCache).toHaveBeenCalledWith('user-1');
      // Token rotation closes the stale-JWT window — without it the
      // access token's `examType` claim still points at the old
      // level for up to the access TTL (~15 min).
      expect(tokens.issuePair).toHaveBeenCalled();
      expect(out.tokens).not.toBeNull();
    });

    it('updateExamType skips token rotation + cache purge when only formLevel changes', async () => {
      const user = makeUser({
        examType: ExamType.WASSCE,
        schoolLevel: SchoolLevel.SHS,
        formLevel: 1,
      });
      usersRepo.findOne.mockResolvedValueOnce(user);
      const out = await service.updateExamType('user-1', ExamType.WASSCE, 2, {
        deviceId: 'dev-1',
      });
      expect(out.user.formLevel).toBe(2);
      expect(out.tokens).toBeNull();
      expect(subsService.invalidateCache).not.toHaveBeenCalled();
    });
  });
});
