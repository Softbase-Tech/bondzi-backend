import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtStrategy } from './jwt.strategy';
import { DeviceSession } from '../entities/device-session.entity';
import { RedisService } from '../../../common/redis/redis.service';
import { UserRole } from '../../../common/types/enums';

/**
 * JwtStrategy is the security gate for every authenticated request. The
 * tests below cover the launch-blocking device-binding check that closes
 * the "DEVICE_KICKED access token survives 15 min" hole, plus the
 * revocation path.
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

  it('accepts a token whose `did` matches the cached active deviceId', async () => {
    redis.getJson.mockResolvedValueOnce('device-A');
    const out = await strategy.validate(basePayload);
    expect(out.id).toBe('user-1');
    expect(sessionsRepo.findOne).not.toHaveBeenCalled();
  });

  it('rejects DEVICE_KICKED when the cached deviceId points elsewhere', async () => {
    redis.getJson.mockResolvedValueOnce('device-B');
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

  it('falls through to the DB when the cache is cold', async () => {
    redis.getJson.mockResolvedValueOnce(null);
    sessionsRepo.findOne.mockResolvedValueOnce({
      id: 's1',
      deviceId: 'device-A',
    });
    const out = await strategy.validate(basePayload);
    expect(out.id).toBe('user-1');
    expect(sessionsRepo.findOne).toHaveBeenCalled();
    // Re-warms the cache for subsequent requests.
    expect(redis.setJson).toHaveBeenCalled();
  });

  it('rejects on cold cache when no device_sessions row exists', async () => {
    redis.getJson.mockResolvedValueOnce(null);
    sessionsRepo.findOne.mockResolvedValueOnce(null);
    await expect(strategy.validate(basePayload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
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
