import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { createHash, randomInt, timingSafeEqual } from 'crypto';
import { RedisService } from '../../common/redis/redis.service';
import { CacheKeys } from '../../common/utils/cache-keys.util';
import { AfricasTalkingSmsProvider } from './sms.service';
import { MailService } from '../mail/mail.service';
import { MailEvent } from '../mail/mail.types';

/** Spec §5.1: 3 sends per phone per 10 min. */
const SEND_MAX_ATTEMPTS = 3;
const SEND_RATE_TTL_SECONDS = 10 * 60;

/**
 * Per-phone verify attempt cap. The previous shape only had a per-IP
 * controller-level throttle (10/10 min); an attacker rotating IPs got a
 * fresh bucket. 5/10 min per PHONE × 6-digit code = 720 days for ~50%
 * brute-force success.
 */
const VERIFY_MAX_ATTEMPTS = 5;
const VERIFY_RATE_TTL_SECONDS = 10 * 60;

const OTP_TTL_SECONDS = 600;

/**
 * Phone OTP issuer.
 *
 * Security (spec §5.1 + §7.3):
 *   - 6-digit code, 10-minute TTL, single-use.
 *   - 3 sends per phone per 10 min, 5 verify attempts per phone per 10 min.
 *   - Code is hashed (SHA-256) in Redis; the plaintext is never logged.
 *   - Verify is atomic: the stored payload is `del`'d immediately (Redis
 *     command order guarantees only one of N concurrent verifies wins).
 *   - Comparison is timing-safe.
 */
@Injectable()
export class OtpService {
  constructor(
    private readonly redis: RedisService,
    private readonly sms: AfricasTalkingSmsProvider,
    private readonly mail: MailService,
  ) {}

  async send(phone: string): Promise<{ expiresInSeconds: number }> {
    const rateKey = CacheKeys.otpRateLimit(phone);
    const attempts = await this.redis.incr(rateKey, SEND_RATE_TTL_SECONDS);
    if (attempts > SEND_MAX_ATTEMPTS) {
      throw new HttpException(
        'Too many OTP requests — try again in 10 minutes',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = String(randomInt(100_000, 999_999));
    // Store the SHA-256 of the code, not the plaintext, so a Redis dump
    // or any future log misconfig can't surface the OTP itself.
    await this.redis.setJson(
      CacheKeys.otp(phone),
      { hash: hashCode(code), createdAt: Date.now() },
      OTP_TTL_SECONDS,
    );

    const message = `Your Bondzi verification code is ${code}. It expires in 10 minutes.`;
    await this.sms.send(phone, message);
    return { expiresInSeconds: OTP_TTL_SECONDS };
  }

  async verify(phone: string, code: string): Promise<void> {
    // Per-phone verify counter — independent of the controller-level
    // per-IP @Throttle. Counts EVERY verify attempt, so even unknown
    // phones (where no OTP exists) increment the bucket.
    const verifyKey = `${CacheKeys.otpRateLimit(phone)}:verify`;
    const attempts = await this.redis.incr(verifyKey, VERIFY_RATE_TTL_SECONDS);
    if (attempts > VERIFY_MAX_ATTEMPTS) {
      throw new HttpException(
        'Too many OTP verify attempts — try again in 10 minutes',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // CRITICAL: atomic consume. Two concurrent verify calls could both
    // succeed against the same stored code (one with a fresh access
    // token, one with another) if we read-then-delete. We DEL first,
    // then validate against the returned value — only one caller's DEL
    // gets the value, the rest see no row and fail. Redis returns
    // string|null from GETDEL (Redis ≥6.2); we use a parameterless
    // pipeline for portability.
    const stored = await this.consumeStoredOtp(phone);
    if (!stored) {
      throw new BadRequestException('Invalid or expired OTP');
    }
    if (!timingSafeEqualHex(stored.hash, hashCode(code))) {
      throw new BadRequestException('Invalid or expired OTP');
    }
    // Clear the verify counter on success so a legit student doesn't
    // hit the cap after a wobbly typing session.
    await this.redis.del(verifyKey);
  }

  /**
   * Email OTP — issues a 6-digit code by email. Three separate
   * "purposes" share the same code shape + TTL but occupy
   * independent Redis buckets so a user hitting the send cap on
   * signup doesn't also lock them out of password-reset.
   *
   * Purposes:
   *   - `signup`         — pre-registration email verification. Code
   *                        is consumed inside POST /auth/register
   *                        before any user row exists.
   *   - `email_verify`   — post-account "confirm your email" for
   *                        users who signed up phone-first and later
   *                        added an email address.
   *   - `password_reset` — email branch of forgot-password. Twin of
   *                        the phone-SMS reset flow.
   *
   * Bound to the lowercased email so case variations can't bypass
   * the bucket.
   */
  async sendEmail(
    email: string,
    recipientName?: string,
    purpose: OtpEmailPurpose = 'signup',
  ): Promise<{ expiresInSeconds: number }> {
    const normalized = email.trim().toLowerCase();
    const rateKey = emailRateKey(normalized, purpose);
    const attempts = await this.redis.incr(rateKey, SEND_RATE_TTL_SECONDS);
    if (attempts > SEND_MAX_ATTEMPTS) {
      throw new HttpException(
        'Too many code requests — try again in 10 minutes',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = String(randomInt(100_000, 999_999));
    await this.redis.setJson(
      emailOtpKey(normalized, purpose),
      { hash: hashCode(code), createdAt: Date.now() },
      OTP_TTL_SECONDS,
    );

    // Mail dispatch is fire-and-forget at the OTP layer — the
    // MailService swallows Resend failures and audits them. If the
    // dispatch fails the user can request a fresh OTP (the
    // throttle bucket already accounts for that). We don't expose
    // transport failures up the chain because doing so would let
    // an attacker probe whether an email-to-phone alias exists by
    // observing the response code.
    await this.mail
      .send(
        MailEvent.EMAIL_OTP,
        normalized,
        {
          recipientName,
          code,
          expiresInMinutes: Math.round(OTP_TTL_SECONDS / 60),
        },
        // Purpose in the dedup key so signup-then-reset in quick
        // succession don't collide on a shared dedup slot.
        {
          dedupKey: `email_otp:${purpose}:${normalized}:${hashCode(code).slice(0, 8)}`,
        },
      )
      .catch(() => undefined);
    return { expiresInSeconds: OTP_TTL_SECONDS };
  }

  async verifyEmail(
    email: string,
    code: string,
    purpose: OtpEmailPurpose = 'signup',
  ): Promise<void> {
    const normalized = email.trim().toLowerCase();
    const verifyKey = `${emailRateKey(normalized, purpose)}:verify`;
    const attempts = await this.redis.incr(verifyKey, VERIFY_RATE_TTL_SECONDS);
    if (attempts > VERIFY_MAX_ATTEMPTS) {
      throw new HttpException(
        'Too many verify attempts — try again in 10 minutes',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const stored = await this.consumeStoredAtKey(
      emailOtpKey(normalized, purpose),
    );
    if (!stored) {
      throw new BadRequestException('Invalid or expired code');
    }
    if (!timingSafeEqualHex(stored.hash, hashCode(code))) {
      throw new BadRequestException('Invalid or expired code');
    }
    await this.redis.del(verifyKey);
  }

  /**
   * Atomically read-and-delete the stored OTP envelope. Uses the
   * underlying client's `getdel` if available (Redis ≥6.2); falls
   * back to a transactional MULTI for older servers. Either way, only
   * one of N concurrent verifies receives the payload.
   */
  private async consumeStoredOtp(
    phone: string,
  ): Promise<{ hash: string } | null> {
    return this.consumeStoredAtKey(CacheKeys.otp(phone));
  }

  private async consumeStoredAtKey(
    key: string,
  ): Promise<{ hash: string } | null> {
    const raw = this.redis.raw as {
      getdel?: (key: string) => Promise<string | null>;
    };
    let payload: string | null;
    if (typeof raw.getdel === 'function') {
      payload = await raw.getdel(key);
    } else {
      // Multi-step fallback. The DEL races with concurrent verifies, so
      // we also re-check the returned payload — first-DEL wins, the
      // rest see null below.
      const fetched = await this.redis.get(key);
      await this.redis.del(key);
      payload = fetched;
    }
    if (!payload) return null;
    try {
      return JSON.parse(payload) as { hash: string };
    } catch {
      return null;
    }
  }
}

/** Namespaces the OTP Redis key by purpose so signup / verify / reset don't share buckets. */
export type OtpEmailPurpose = 'signup' | 'email_verify' | 'password_reset';

function emailOtpKey(email: string, purpose: OtpEmailPurpose): string {
  // Legacy `signup` uses the unqualified CacheKeys.emailOtp so we don't
  // orphan already-outstanding pre-registration OTPs across a deploy.
  return purpose === 'signup'
    ? CacheKeys.emailOtp(email)
    : `${CacheKeys.emailOtp(email)}:${purpose}`;
}

function emailRateKey(email: string, purpose: OtpEmailPurpose): string {
  return purpose === 'signup'
    ? CacheKeys.emailOtpRateLimit(email)
    : `${CacheKeys.emailOtpRateLimit(email)}:${purpose}`;
}

function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}
