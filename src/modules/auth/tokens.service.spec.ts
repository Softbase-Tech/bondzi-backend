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
 * TokensService is the JWT + per-device-session boundary. Tests
 * cover the security guarantees:
 *
 *   - issuePair stamps the access token with `subscriptionStatus`.
 *   - issuePair UPSERTs on (user_id, device_id) — two devices for
 *     the same user coexist, one row per device.
 *   - rotate finds the (user, device) session by BOTH userId and
 *     deviceId, and rejects with DEVICE_KICKED when no row matches
 *     (this device was logged out or a full logoutAll ran).
 *   - rotate rejects an invalid signature with a generic 401.
 *   - rotate rejects an inactive user.
 *   - logoutUser(userId, deviceId) closes ONE device only.
 *   - logoutAll(userId) closes every device and clears every
 *     per-device Redis marker.
 *   - revokeByAccessJti writes the blacklist key with a bounded TTL.
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
    find: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
    manager: { getRepository: jest.Mock; query: jest.Mock };
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
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn(),
      createQueryBuilder: jest.fn(() => insertBuilder),
      manager: {
        getRepository: jest.fn(() => usersRepo),
        // Raw INSERT ... ON CONFLICT DO UPDATE for the atomic UPSERT
        // in issuePair — TypeORM's .orUpdate() can't express the
        // "previous_refresh_jti = device_sessions.refresh_token_jti"
        // column-to-column move (that needs a raw SET clause), so
        // the service reaches for manager.query() directly. Mocked
        // to resolve successfully; individual tests assert on the
        // call arguments where the SQL shape matters.
        query: jest.fn().mockResolvedValue(undefined),
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
    it('upserts on (user_id, device_id) — per-device enforcement', async () => {
      // Under per-device the UPSERT conflict target widens to
      // (user_id, device_id) so two devices for the same account
      // insert two rows. Grace-move for previous jti is still
      // needed for the honest refresh-race case.
      redis.getJson.mockResolvedValueOnce(null);
      subsRepo.findOne.mockResolvedValueOnce(null);
      await service.issuePair(baseUser, { deviceId: 'd1' });
      expect(sessionsRepo.delete).not.toHaveBeenCalled();
      expect(sessionsRepo.manager.query).toHaveBeenCalledTimes(1);
      const [sql, params] = sessionsRepo.manager.query.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO device_sessions/);
      expect(sql).toMatch(/ON CONFLICT \(user_id, device_id\) DO UPDATE/);
      // Grace-move must be present: previous jti receives the
      // pre-update refresh_token_jti and expires after a positive
      // interval.
      expect(sql).toMatch(
        /previous_refresh_jti = device_sessions\.refresh_token_jti/,
      );
      expect(sql).toMatch(/previous_jti_expires_at = now\(\) \+/);
      expect(params[0]).toBe('user-1');
      expect(params[1]).toBe('d1');
      expect(typeof params[3]).toBe('string');
      expect(params[3].length).toBeGreaterThan(0);
    });

    it('sets a per-device active marker in Redis for JwtStrategy fast-path', async () => {
      redis.getJson.mockResolvedValueOnce(null);
      subsRepo.findOne.mockResolvedValueOnce(null);
      await service.issuePair(baseUser, { deviceId: 'd1' });
      // Per-device marker key is `active_device:<userId>:<deviceId>`
      // so a logout on one device doesn't invalidate the marker for
      // another.
      const deviceCacheCall = redis.setJson.mock.calls.find(
        (call) =>
          typeof call[0] === 'string' && call[0] === 'active_device:user-1:d1',
      );
      expect(deviceCacheCall).toBeDefined();
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

    it('returns DEVICE_KICKED when this device has no session row', async () => {
      // Under per-device the findOne filters on (userId, deviceId).
      // If no row matches, that specific device was logged out (or
      // logoutAll ran) — refuse the refresh.
      jwt.verifyAsync.mockResolvedValueOnce({
        sub: 'user-1',
        jti: 'old-jti',
        did: 'd1',
      });
      sessionsRepo.findOne.mockResolvedValueOnce(null);
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
      // Filter must include deviceId so a sibling device's row can't
      // authorise this token.
      expect(sessionsRepo.findOne).toHaveBeenCalledWith({
        where: { userId: 'user-1', deviceId: 'd1' },
      });
    });

    it('returns DEVICE_KICKED when the JTI no longer matches the row', async () => {
      // Sibling case: row exists for (user, device) but JTI has
      // rotated past the grace window.
      jwt.verifyAsync.mockResolvedValueOnce({
        sub: 'user-1',
        jti: 'stale-jti',
        did: 'd1',
      });
      sessionsRepo.findOne.mockResolvedValueOnce({
        userId: 'user-1',
        deviceId: 'd1',
        refreshTokenJti: 'current-jti',
        previousRefreshJti: null,
        previousJtiExpiresAt: null,
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

  it('logoutUser(userId, deviceId) closes ONLY that device', async () => {
    await service.logoutUser('user-1', 'd1');
    expect(sessionsRepo.delete).toHaveBeenCalledTimes(1);
    expect(sessionsRepo.delete).toHaveBeenCalledWith({
      userId: 'user-1',
      deviceId: 'd1',
    });
    // Only that device's active marker is cleared. Any sibling
    // device's marker survives untouched.
    expect(redis.del).toHaveBeenCalledWith('active_device:user-1:d1');
  });

  it('logoutUser with no deviceId falls back to logoutAll semantics', async () => {
    sessionsRepo.find.mockResolvedValueOnce([
      { deviceId: 'd1' },
      { deviceId: 'd2' },
    ]);
    await service.logoutUser('user-1');
    expect(sessionsRepo.delete).toHaveBeenCalledWith({ userId: 'user-1' });
    expect(redis.del).toHaveBeenCalledWith('active_device:user-1:d1');
    expect(redis.del).toHaveBeenCalledWith('active_device:user-1:d2');
  });

  it('logoutAll wipes every device row + every per-device marker', async () => {
    sessionsRepo.find.mockResolvedValueOnce([
      { deviceId: 'web' },
      { deviceId: 'phone' },
    ]);
    await service.logoutAll('user-1');
    expect(sessionsRepo.delete).toHaveBeenCalledWith({ userId: 'user-1' });
    expect(redis.del).toHaveBeenCalledWith('active_device:user-1:web');
    expect(redis.del).toHaveBeenCalledWith('active_device:user-1:phone');
  });
});
