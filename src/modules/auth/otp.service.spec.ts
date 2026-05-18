import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { createHash } from 'crypto';
import { Test } from '@nestjs/testing';
import { OtpService } from './otp.service';
import { RedisService } from '../../common/redis/redis.service';
import { AfricasTalkingSmsProvider } from './sms.service';

/**
 *  - send(): rate-limits to 3 per phone per 10 min (HTTP 429), stores the
 *    SHA-256 hash of the code in Redis with TTL, and dispatches the SMS.
 *  - verify(): atomic — uses GETDEL (or get+del fallback) so concurrent
 *    verifies can't both succeed. Per-phone attempt counter caps brute
 *    force at 5/10 min regardless of IP rotation.
 */

function sha(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

describe('OtpService', () => {
  let service: OtpService;
  let redis: {
    incr: jest.Mock;
    setJson: jest.Mock;
    get: jest.Mock;
    del: jest.Mock;
    raw: { getdel: jest.Mock };
  };
  let sms: { send: jest.Mock };

  beforeEach(async () => {
    redis = {
      incr: jest.fn(),
      setJson: jest.fn(),
      get: jest.fn(),
      del: jest.fn(),
      raw: { getdel: jest.fn() },
    };
    sms = { send: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        OtpService,
        { provide: RedisService, useValue: redis },
        { provide: AfricasTalkingSmsProvider, useValue: sms },
      ],
    }).compile();
    service = moduleRef.get(OtpService);
  });

  describe('send', () => {
    it('returns 429 after 3 sends in the rate-limit window', async () => {
      redis.incr.mockResolvedValueOnce(4);
      let caught: unknown;
      try {
        await service.send('+233500000000');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(HttpException);
      expect((caught as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      expect(sms.send).not.toHaveBeenCalled();
    });

    it('stores a hashed code with the 10-minute TTL and dispatches an SMS', async () => {
      redis.incr.mockResolvedValueOnce(1);
      await service.send('+233500000000');
      const [, payload, ttl] = redis.setJson.mock.calls[0];
      const hash = (payload as { hash: string }).hash;
      // Code is hashed (SHA-256 hex → 64 chars), never stored plaintext.
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect((payload as { code?: string }).code).toBeUndefined();
      expect(ttl).toBe(600);
      expect(sms.send).toHaveBeenCalledWith(
        '+233500000000',
        expect.stringContaining('verification code'),
      );
    });
  });

  describe('verify', () => {
    it('rejects when no stored OTP exists', async () => {
      redis.incr.mockResolvedValueOnce(1);
      redis.raw.getdel.mockResolvedValueOnce(null);
      await expect(
        service.verify('+233500000000', '123456'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a mismatched code with 400', async () => {
      redis.incr.mockResolvedValueOnce(1);
      redis.raw.getdel.mockResolvedValueOnce(
        JSON.stringify({ hash: sha('111111') }),
      );
      await expect(
        service.verify('+233500000000', '222222'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('atomically consumes the code on success (GETDEL fetches once)', async () => {
      redis.incr.mockResolvedValueOnce(1);
      redis.raw.getdel.mockResolvedValueOnce(
        JSON.stringify({ hash: sha('111111') }),
      );
      await service.verify('+233500000000', '111111');
      expect(redis.raw.getdel).toHaveBeenCalledTimes(1);
    });

    it('caps verify attempts per-phone at 5 per 10 min (429)', async () => {
      // Sixth attempt trips the per-phone bucket regardless of the
      // controller-level per-IP throttle.
      redis.incr.mockResolvedValueOnce(6);
      let caught: unknown;
      try {
        await service.verify('+233500000000', '123456');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(HttpException);
      expect((caught as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      // Counter was incremented BEFORE any read — refuses without touching
      // the stored OTP so we don't leak existence.
      expect(redis.raw.getdel).not.toHaveBeenCalled();
    });
  });
});
