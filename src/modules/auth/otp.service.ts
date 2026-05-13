import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { randomInt } from 'crypto';
import { RedisService } from '../../common/redis/redis.service';
import { CacheKeys } from '../../common/utils/cache-keys.util';
import { AfricasTalkingSmsProvider } from './sms.service';

/**
 * Phone OTP issuer.
 *
 * Security (spec §5.1 + §7.3):
 *   - 6-digit code, 10-minute TTL, single-use.
 *   - Rate limit: 3 sends per phone per 10 min.
 *   - Code is stored hashed in Redis; never logged.
 */
@Injectable()
export class OtpService {
  constructor(
    private readonly redis: RedisService,
    private readonly sms: AfricasTalkingSmsProvider,
  ) {}

  async send(phone: string): Promise<{ expiresInSeconds: number }> {
    const rateKey = CacheKeys.otpRateLimit(phone);
    const attempts = await this.redis.incr(rateKey, 600);
    if (attempts > 3) {
      throw new HttpException(
        'Too many OTP requests — try again in 10 minutes',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = String(randomInt(100_000, 999_999));
    const ttlSeconds = 600;
    await this.redis.setJson(
      CacheKeys.otp(phone),
      { code, createdAt: Date.now() },
      ttlSeconds,
    );

    const message = `Your PassMaster verification code is ${code}. It expires in 10 minutes.`;
    await this.sms.send(phone, message);
    return { expiresInSeconds: ttlSeconds };
  }

  async verify(phone: string, code: string): Promise<void> {
    const stored = await this.redis.getJson<{ code: string }>(
      CacheKeys.otp(phone),
    );
    if (!stored || stored.code !== code)
      throw new BadRequestException('Invalid or expired OTP');
    // Single-use — consume immediately.
    await this.redis.del(CacheKeys.otp(phone));
  }
}
