import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TokensService } from './tokens.service';
import { DeviceSession } from './entities/device-session.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { User } from '../users/entities/user.entity';
import { RedisService } from '../../common/redis/redis.service';
import { SubscriptionStatus } from '../../common/types/enums';

/**
 * TokensService is the JWT + single-device-enforcement boundary. The tests
 * below cover the security guarantees:
 *
 *   - issuePair stamps the access token with `subscriptionStatus` so
 *     SubscriptionGuard doesn't have to hit Redis on every request.
 *   - issuePair deletes any prior device_sessions row for the user, then
 *     inserts the new one — single-device enforcement is enforced HERE.
 *   - rotate rejects with `DEVICE_KICKED` when the refresh-token JTI
 *     doesn't match the stored session (i.e. another device took over).
 *   - rotate rejects an invalid signature with a generic 401.
 *   - rotate rejects an inactive user.
 *   - revokeByAccessJti writes the blacklist key with a TTL bounded by the
 *     access-token expiry.
 */

const baseUser = {
  id: 'user-1',
  email: 'u@example.com',
  phone: null,
  role: 'student',
  examType: 'wassce',
  isActive: true,
} as unknown as User;

describe('TokensService', () => {
  let service: TokensService;
  let jwt: { signAsync: jest.Mock; verifyAsync: jest.Mock };
  let insertBuilder: {
    insert: jest.Mock;
    into: jest.Mock;
    values: jest.Mock;
    orUpdate: jest.Mock;
    execute: jest.Mock;
  };
  let sessionsRepo: {
    findOne: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
    manager: { getRepository: jest.Mock };
  };
  let subsRepo: { findOne: jest.Mock };
  let redis: {
    getJson: jest.Mock;
    setJson: jest.Mock;
    del: jest.Mock;
  };
  let config: { get: jest.Mock };
  let usersRepo: { findOne: jest.Mock };
  let subscriptions: { entitlementFor: jest.Mock };

  beforeEach(async () => {
    jwt = {
      signAsync: jest.fn(
        async (payload) => `signed:${JSON.stringify(payload)}`,
      ),
      verifyAsync: jest.fn(),
    };
    usersRepo = { findOne: jest.fn() };
    // The new atomic UPSERT path uses a chainable query-builder.
    insertBuilder = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orUpdate: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    sessionsRepo = {
      findOne: jest.fn(),
      delete: jest.fn(),
      createQueryBuilder: jest.fn(() => insertBuilder),
      manager: {
        getRepository: jest.fn(() => usersRepo),
      },
    };
    subsRepo = { findOne: jest.fn() };
    redis = {
      getJson: jest.fn(),
      setJson: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };
    config = {
      get: jest.fn((k: string) => {
        if (k === 'jwt.accessExpiry') return '15m';
        if (k === 'jwt.refreshExpiry') return '30d';
        if (k === 'jwt.accessSecret') return 'a-secret';
        if (k === 'jwt.refreshSecret') return 'r-secret';
        return undefined;
      }),
    };

    subscriptions = {
      entitlementFor: jest.fn().mockResolvedValue({
        account: 'free',
        expiresAt: null,
        subscriptionId: null,
      }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        TokensService,
        { provide: JwtService, useValue: jwt },
        { provide: ConfigService, useValue: config },
        { provide: RedisService, useValue: redis },
        { provide: getRepositoryToken(DeviceSession), useValue: sessionsRepo },
        { provide: getRepositoryToken(Subscription), useValue: subsRepo },
        {
          provide: (await import('../subscriptions/subscriptions.service'))
            .SubscriptionsService,
          useValue: subscriptions,
        },
      ],
    }).compile();
    service = moduleRef.get(TokensService);
  });

  // ----------------------------- issuePair -----------------------------

  describe('issuePair', () => {
    it('upserts the session for the user (atomic, single-device enforcement)', async () => {
      // The previous shape was a separate `delete` + `insert` that could
      // race two simultaneous logins. The fix is a single ON CONFLICT
      // UPSERT keyed by user_id — verify we go through the query-builder
      // chain rather than the two-call path.
      redis.getJson.mockResolvedValueOnce(null);
      subsRepo.findOne.mockResolvedValueOnce(null);
      await service.issuePair(baseUser, { deviceId: 'd1' });
      expect(sessionsRepo.delete).not.toHaveBeenCalled();
      expect(sessionsRepo.createQueryBuilder).toHaveBeenCalled();
      expect(insertBuilder.values).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          deviceId: 'd1',
          refreshTokenJti: expect.any(String),
        }),
      );
      expect(insertBuilder.orUpdate).toHaveBeenCalledWith(
        expect.arrayContaining(['device_id', 'refresh_token_jti']),
        ['user_id'],
      );
      expect(insertBuilder.execute).toHaveBeenCalled();
    });

    it('caches the bound deviceId so JwtStrategy can reject mismatched tokens', async () => {
      redis.getJson.mockResolvedValueOnce(null);
      subsRepo.findOne.mockResolvedValueOnce(null);
      await service.issuePair(baseUser, { deviceId: 'd1' });
      // Two setJson calls: one for the subscription-status cache (warm
      // path), one for the active-device cache. We only assert the
      // device-id one is there with a positive TTL.
      const deviceCacheCall = redis.setJson.mock.calls.find(
        (call) =>
          typeof call[0] === 'string' && call[0].startsWith('active_device:'),
      );
      expect(deviceCacheCall).toBeDefined();
      expect(deviceCacheCall![1]).toBe('d1');
      expect(deviceCacheCall![2]).toBeGreaterThan(0);
    });

    it('stamps the access token with the current account from entitlementFor', async () => {
      subscriptions.entitlementFor.mockResolvedValueOnce({
        account: 'pro',
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
        subscriptionId: 'sub-1',
      });
      await service.issuePair(baseUser, { deviceId: 'd1' });
      const accessSignArgs = jwt.signAsync.mock.calls[0];
      expect(accessSignArgs[0]).toMatchObject({
        sub: 'user-1',
        // Under the per-level model, the JWT carries the user's account on
        // their current level (`pro`, `plus`, `free`, or `expired`) rather
        // than the legacy subscription status enum.
        subscriptionStatus: 'pro',
        did: 'd1',
      });
    });

    it('downgrades subscriptionStatus to "expired" when expiresAt has passed', async () => {
      subscriptions.entitlementFor.mockResolvedValueOnce({
        account: 'pro',
        expiresAt: new Date(Date.now() - 1000),
        subscriptionId: 'sub-1',
      });
      await service.issuePair(baseUser, { deviceId: 'd1' });
      const accessSignArgs = jwt.signAsync.mock.calls[0];
      expect(accessSignArgs[0].subscriptionStatus).toBe('expired');
    });

    it('emits "free" for a user with no subscription row', async () => {
      redis.getJson.mockResolvedValueOnce(null);
      subsRepo.findOne.mockResolvedValueOnce(null);
      await service.issuePair(baseUser, { deviceId: 'd1' });
      const accessSignArgs = jwt.signAsync.mock.calls[0];
      expect(accessSignArgs[0].subscriptionStatus).toBe('free');
    });

    it('uses the Redis-cached subscription status when present (skips the DB)', async () => {
      redis.getJson.mockResolvedValueOnce({
        status: SubscriptionStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await service.issuePair(baseUser, { deviceId: 'd1' });
      expect(subsRepo.findOne).not.toHaveBeenCalled();
    });
  });

  // ------------------------------ rotate ------------------------------

  describe('rotate', () => {
    it('rejects an invalid refresh signature with a generic 401', async () => {
      jwt.verifyAsync.mockRejectedValueOnce(new Error('bad sig'));
      await expect(service.rotate('rt')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('returns DEVICE_KICKED when the JTI no longer matches the stored session', async () => {
      jwt.verifyAsync.mockResolvedValueOnce({
        sub: 'user-1',
        jti: 'old-jti',
        did: 'd1',
      });
      sessionsRepo.findOne.mockResolvedValueOnce({
        userId: 'user-1',
        deviceId: 'd2',
        refreshTokenJti: 'new-jti',
      });
      let caught: unknown;
      try {
        await service.rotate('rt');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(UnauthorizedException);
      const body = (caught as UnauthorizedException).getResponse() as {
        code: string;
      };
      expect(body.code).toBe('DEVICE_KICKED');
    });

    it('rejects rotation for an inactive user', async () => {
      jwt.verifyAsync.mockResolvedValueOnce({
        sub: 'user-1',
        jti: 'jti-1',
        did: 'd1',
      });
      sessionsRepo.findOne.mockResolvedValueOnce({
        userId: 'user-1',
        deviceId: 'd1',
        refreshTokenJti: 'jti-1',
      });
      usersRepo.findOne.mockResolvedValueOnce({ ...baseUser, isActive: false });
      await expect(service.rotate('rt')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('issues a fresh pair when the session + user are valid', async () => {
      jwt.verifyAsync.mockResolvedValueOnce({
        sub: 'user-1',
        jti: 'jti-1',
        did: 'd1',
      });
      sessionsRepo.findOne.mockResolvedValueOnce({
        userId: 'user-1',
        deviceId: 'd1',
        refreshTokenJti: 'jti-1',
      });
      usersRepo.findOne.mockResolvedValueOnce(baseUser);
      redis.getJson.mockResolvedValueOnce(null);
      subsRepo.findOne.mockResolvedValueOnce(null);
      const out = await service.rotate('rt');
      expect(out.accessToken).toContain('signed:');
      expect(out.refreshToken).toContain('signed:');
    });
  });

  // ------------------------- revoke / logout -------------------------

  it('revokeByAccessJti writes a Redis key with a TTL bounded by token expiry', async () => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    await service.revokeByAccessJti('jti-1', exp);
    expect(redis.setJson).toHaveBeenCalledWith(
      expect.stringContaining('jti-1'),
      '1',
      expect.any(Number),
    );
    const [, , ttl] = redis.setJson.mock.calls[0];
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it('logoutUser and logoutAll both delete the user device session AND drop the cached deviceId', async () => {
    await service.logoutUser('user-1');
    await service.logoutAll('user-1');
    expect(sessionsRepo.delete).toHaveBeenCalledTimes(2);
    expect(sessionsRepo.delete).toHaveBeenLastCalledWith({ userId: 'user-1' });
    // The cached deviceId MUST be cleared on logout so any in-flight
    // access tokens fail the JwtStrategy device-binding check instead
    // of surviving until the access-token TTL expires.
    const activeDeviceClears = redis.del.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].startsWith('active_device:'),
    );
    expect(activeDeviceClears.length).toBe(2);
  });
});
