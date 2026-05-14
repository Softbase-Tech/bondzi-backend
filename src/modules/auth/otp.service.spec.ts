import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OtpService } from './otp.service';
import { RedisService } from '../../common/redis/redis.service';
import { AfricasTalkingSmsProvider } from './sms.service';

/**
 *  - send(): rate-limits to 3 per phone per 10 min (HTTP 429), stores the
 *    code in Redis with TTL, and dispatches the SMS.
 *  - verify(): invalid / expired codes throw 400, valid codes are consumed
 *    immediately so they can't be reused.
 */

describe('OtpService', () => {
  let service: OtpService;
  let redis: {
    incr: jest.Mock;
    setJson: jest.Mock;
    getJson: jest.Mock;
    del: jest.Mock;
  };
  let sms: { send: jest.Mock };

  beforeEach(async () => {
    redis = {
      incr: jest.fn(),
      setJson: jest.fn(),
      getJson: jest.fn(),
      del: jest.fn(),
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

    it('stores a 6-digit code with the 10-minute TTL and dispatches an SMS', async () => {
      redis.incr.mockResolvedValueOnce(1);
      await service.send('+233500000000');
      const [, payload, ttl] = redis.setJson.mock.calls[0];
      expect(typeof (payload as { code: string }).code).toBe('string');
      expect((payload as { code: string }).code).toMatch(/^\d{6}$/);
      expect(ttl).toBe(600);
      expect(sms.send).toHaveBeenCalledWith(
        '+233500000000',
        expect.stringContaining('verification code'),
      );
    });
  });

  describe('verify', () => {
    it('rejects an unknown / expired code with 400', async () => {
      redis.getJson.mockResolvedValueOnce(null);
      await expect(
        service.verify('+233500000000', '123456'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a mismatched code with 400', async () => {
      redis.getJson.mockResolvedValueOnce({ code: '111111' });
      await expect(
        service.verify('+233500000000', '222222'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('consumes the code on a successful verify (single-use)', async () => {
      redis.getJson.mockResolvedValueOnce({ code: '111111' });
      await service.verify('+233500000000', '111111');
      expect(redis.del).toHaveBeenCalledTimes(1);
    });
  });
});
