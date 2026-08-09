import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtStrategy } from './jwt.strategy';
import { DeviceSession } from '../entities/device-session.entity';
import { RedisService } from '../../../common/redis/redis.service';
import { UserRole } from '../../../common/types/enums';

/**
 * JwtStrategy is the security gate for every authenticated request.
 * Tests cover the per-device binding check (presence of a
 * per-(user, device) marker or fallback DB row proves this device
 * is still signed in) plus the JTI revocation path.
 */

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;
  let redis: { get: jest.Mock; getJson: jest.Mock; setJson: jest.Mock };
  let sessionsRepo: { findOne: jest.Mock };

  beforeEach(async () => {
    redis = {
      get: jest.fn().mockResolvedValue(null),
      getJson: jest.fn().mockResolvedValue(null),
      setJson: jest.fn().mockResolvedValue(undefined),
    };
    sessionsRepo = { findOne: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        JwtStrategy,
        {
          provide: ConfigService,
          useValue: { get: () => 'secret-that-is-at-least-32-chars-long' },
        },
        { provide: RedisService, useValue: redis },
        { provide: getRepositoryToken(DeviceSession), useValue: sessionsRepo },
      ],
    }).compile();
    strategy = moduleRef.get(JwtStrategy);
  });

  const basePayload = {
    sub: 'user-1',
    email: null,
    phone: null,
    role: UserRole.STUDENT,
    jti: 'jti-1',
    did: 'device-A',
  };

  // --------------------------- revocation ---------------------------

  it('rejects a token whose JTI has been blacklisted (logout)', async () => {
    redis.get.mockResolvedValueOnce('1'); // revoked
    await expect(strategy.validate(basePayload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  // ------------------------- device binding -------------------------

  it('accepts a token when the per-(user, device) cache marker is set', async () => {
    // Cache key is `active_device:<userId>:<deviceId>` — presence = valid.
    redis.getJson.mockImplementation(async (key: string) => {
      if (key === 'active_device:user-1:device-A') return '1';
      return null;
    });
    const out = await strategy.validate(basePayload);
    expect(out.id).toBe('user-1');
    expect(out.did).toBe('device-A');
    expect(sessionsRepo.findOne).not.toHaveBeenCalled();
  });

  it('falls through to the DB when the cache is cold and a matching row exists', async () => {
    redis.getJson.mockResolvedValueOnce(null);
    sessionsRepo.findOne.mockResolvedValueOnce({ id: 's1' });
    const out = await strategy.validate(basePayload);
    expect(out.id).toBe('user-1');
    // Lookup MUST filter on both userId and deviceId — a sibling
    // device's row must not authorise a token for THIS device.
    expect(sessionsRepo.findOne).toHaveBeenCalledWith({
      where: { userId: 'user-1', deviceId: 'device-A' },
      select: { id: true },
    });
    // Re-warms the per-device cache for subsequent requests.
    expect(redis.setJson).toHaveBeenCalledWith(
      'active_device:user-1:device-A',
      '1',
      expect.any(Number),
    );
  });

  it('rejects DEVICE_KICKED on cold cache when no device_sessions row exists', async () => {
    redis.getJson.mockResolvedValueOnce(null);
    sessionsRepo.findOne.mockResolvedValueOnce(null);
    let caught: unknown;
    try {
      await strategy.validate(basePayload);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnauthorizedException);
    const body = (caught as UnauthorizedException).getResponse() as {
      code: string;
    };
    expect(body.code).toBe('DEVICE_KICKED');
  });

  it('accepts legacy tokens without a `did` claim (forward compatibility)', async () => {
    // Tokens issued before the device-binding rollout don't carry `did`.
    // Reject would lock out every user mid-session at deploy; accept and
    // let the next refresh mint a properly-bound pair.
    const legacy = { ...basePayload, did: undefined };
    const out = await strategy.validate(legacy);
    expect(out.id).toBe('user-1');
    expect(redis.getJson).not.toHaveBeenCalled();
    expect(sessionsRepo.findOne).not.toHaveBeenCalled();
  });
});
