import { randomUUID } from 'crypto';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { DeviceSession } from './entities/device-session.entity';
import { RedisService } from '../../common/redis/redis.service';
import { CacheKeys } from '../../common/utils/cache-keys.util';
import { parseExpiryMs } from '../../common/utils/expiry.util';
import { SubscriptionStatus } from '../../common/types/enums';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}

interface RefreshPayload {
  sub: string;
  jti: string;
  did: string;
}

/**
 * v2 token issuance with single-device enforcement.
 *
 * The previous per-family refresh-token table is replaced by `device_sessions`
 * — at most one active session per user. Every fresh login removes any
 * existing session for the user and inserts a new row keyed by device_id.
 *
 * A refresh token carries (userId, jti, deviceId). On rotation we verify that
 * (userId, jti) still matches the `device_sessions` row. If not, it means the
 * session was kicked by another device login and we return DEVICE_KICKED.
 */
@Injectable()
export class TokensService {
  private readonly logger = new Logger(TokensService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @InjectRepository(DeviceSession)
    private readonly sessionsRepo: Repository<DeviceSession>,
    @InjectRepository(Subscription)
    private readonly subsRepo: Repository<Subscription>,
    private readonly redis: RedisService,
  ) {}

  /**
   * Cached subscription-status lookup for JWT stamping. Reuses the same
   * `CacheKeys.subscriptionStatus` key that SubscriptionGuard + the
   * explanation-gate check, so webhook / XP-redemption cache invalidation
   * refreshes the value on the very next access-token refresh.
   *
   * Status mirrors the `subscriptions_status_enum` values literally.
   * Returns `'free'` when the user has no active subscription so clients
   * can branch on a single canonical string.
   */
  private async currentSubscriptionStatus(userId: string): Promise<string> {
    const cacheKey = CacheKeys.subscriptionStatus(userId);
    const cached = await this.redis.getJson<{
      status: SubscriptionStatus;
      expiresAt: string | null;
    }>(cacheKey);
    if (cached) return this.resolveStatus(cached.status, cached.expiresAt);
    const sub = await this.subsRepo.findOne({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    if (!sub) return 'free';
    const expiresAtIso = sub.expiresAt ? sub.expiresAt.toISOString() : null;
    // Same TTL as SubscriptionGuard — they share the cache key. Lower
    // TTL = fresher reads, more DB hits. 60s default is the staleness
    // ceiling after a cancel/refund.
    const ttl =
      this.config.get<number>('app.subscriptionStatusCacheTtlSec') ?? 60;
    await this.redis.setJson(
      cacheKey,
      { status: sub.status, expiresAt: expiresAtIso },
      ttl,
    );
    return this.resolveStatus(sub.status, expiresAtIso);
  }

  private resolveStatus(
    status: SubscriptionStatus,
    expiresAtIso: string | null,
  ): string {
    if (expiresAtIso && new Date(expiresAtIso).getTime() <= Date.now()) {
      return 'expired';
    }
    return status;
  }

  async issuePair(
    user: Pick<User, 'id' | 'email' | 'phone' | 'role' | 'examType'>,
    opts: { deviceId: string; deviceName?: string; ip?: string },
  ): Promise<TokenPair> {
    const accessJti = randomUUID();
    const refreshJti = randomUUID();

    const accessExpiryMs = parseExpiryMs(
      this.config.get<string>('jwt.accessExpiry') ?? '15m',
      15 * 60 * 1000,
    );
    const refreshExpiryMs = parseExpiryMs(
      this.config.get<string>('jwt.refreshExpiry') ?? '30d',
      30 * 24 * 60 * 60 * 1000,
    );

    const accessExpiresAt = new Date(Date.now() + accessExpiryMs);
    const refreshExpiresAt = new Date(Date.now() + refreshExpiryMs);

    const subscriptionStatus = await this.currentSubscriptionStatus(user.id);

    const accessToken = await this.jwt.signAsync(
      {
        sub: user.id,
        email: user.email,
        phone: user.phone,
        role: user.role,
        examType: user.examType,
        subscriptionStatus,
        jti: accessJti,
        did: opts.deviceId,
      },
      {
        secret: this.config.get<string>('jwt.accessSecret') as string,
        expiresIn: Math.floor(accessExpiryMs / 1000),
      },
    );

    const refreshToken = await this.jwt.signAsync(
      {
        sub: user.id,
        jti: refreshJti,
        did: opts.deviceId,
      } satisfies RefreshPayload,
      {
        secret: this.config.get<string>('jwt.refreshSecret') as string,
        expiresIn: Math.floor(refreshExpiryMs / 1000),
      },
    );

    // Single-device enforcement: atomic UPSERT keyed by user_id. Replacing
    // a separate delete-then-insert closes a race where two simultaneous
    // logins for the same account could either violate the unique index
    // `idx_device_sessions_user` or leave inconsistent state (both deletes
    // succeed, one insert wins, the loser thinks it's the active session).
    await this.sessionsRepo
      .createQueryBuilder()
      .insert()
      .into(DeviceSession)
      .values({
        userId: user.id,
        deviceId: opts.deviceId,
        deviceName: opts.deviceName ?? null,
        refreshTokenJti: refreshJti,
        ipAddress: opts.ip ?? null,
      })
      .orUpdate(
        ['device_id', 'device_name', 'refresh_token_jti', 'ip_address'],
        ['user_id'],
      )
      .execute();

    // Cache the currently-bound deviceId so JwtStrategy can reject access
    // tokens whose `did` claim no longer matches the active session —
    // closes the "DEVICE_KICKED access-token survives 15 min" hole.
    // TTL matches the access-token window; after that the token has
    // expired anyway.
    await this.redis.setJson(
      CacheKeys.activeDeviceId(user.id),
      opts.deviceId,
      Math.floor(accessExpiryMs / 1000),
    );

    // Stamp the canonical "last active" timestamp. issuePair is the
    // single chokepoint for every auth artifact issuance (login, OTP
    // verify, Google sign-in, registration, refresh-token rotation),
    // so this one update covers all paths — admins get an accurate
    // "user last seen" column on the /admin/users list and detail
    // views. Best-effort: a write failure logs and continues; we do
    // not refuse a token over an audit-trail blip.
    try {
      await this.sessionsRepo.manager
        .getRepository(User)
        .update({ id: user.id }, { lastActiveAt: new Date() });
    } catch (err) {
      this.logger.warn(
        `[auth] last_active_at stamp failed user=${user.id}: ${(err as Error).message}`,
      );
    }

    return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
  }

  /**
   * Exchange a refresh token for a new pair. Returns 401 DEVICE_KICKED when
   * the session has been taken over by another device.
   */
  async rotate(
    refreshToken: string,
    opts: { ip?: string } = {},
  ): Promise<TokenPair> {
    let payload: RefreshPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshPayload>(refreshToken, {
        secret: this.config.get<string>('jwt.refreshSecret') as string,
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const session = await this.sessionsRepo.findOne({
      where: { userId: payload.sub },
    });
    if (!session || session.refreshTokenJti !== payload.jti) {
      throw new UnauthorizedException({
        code: 'DEVICE_KICKED',
        message: 'Your account was signed in on another device.',
      });
    }

    const user = await this.sessionsRepo.manager
      .getRepository(User)
      .findOne({ where: { id: payload.sub } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('User inactive');
    }

    // Rotation forensics (#98). Stamp this rotation onto the session
    // BEFORE issuing the new pair so the audit trail exists even if
    // issuePair fails partway through. The bump is best-effort —
    // a write failure shouldn't deny a legitimate user their token.
    //
    // Warn on suspicious patterns. The mobile app refreshes from a
    // ~stable IP per session; an IP CHANGE on rotation isn't proof of
    // theft (cellular ↔ wifi flip changes IPs too), but combined with
    // a high rotation rate it's the signal a forensic review needs.
    const previousIp = session.lastRotationIp ?? session.ipAddress;
    if (previousIp && opts.ip && previousIp !== opts.ip) {
      this.logger.warn(
        `[auth] refresh-rotation IP change user=${user.id} prev=${previousIp} new=${opts.ip} rotation_count=${session.rotationCount}`,
      );
    }
    try {
      await this.sessionsRepo.update(
        { id: session.id },
        {
          rotationCount: session.rotationCount + 1,
          lastRotatedAt: new Date(),
          lastRotationIp: opts.ip ?? null,
        },
      );
    } catch (err) {
      // Audit-trail write failed — log and continue. Refusing the
      // token here would lock out a legitimate user whose only
      // problem is a transient DB blip.
      this.logger.warn(
        `[auth] rotation audit update failed user=${user.id}: ${(err as Error).message}`,
      );
    }

    return this.issuePair(user, {
      deviceId: session.deviceId,
      deviceName: session.deviceName ?? undefined,
      ip: opts.ip,
    });
  }

  /** Blacklist an access-token JTI until it expires (for logout). */
  async revokeByAccessJti(jti: string, expiresAtUnix: number): Promise<void> {
    const ttl = Math.max(1, expiresAtUnix - Math.floor(Date.now() / 1000));
    await this.redis.setJson(CacheKeys.revokedJti(jti), '1', ttl);
  }

  /** Logout — delete the user's current device session. */
  async logoutUser(userId: string): Promise<void> {
    await this.sessionsRepo.delete({ userId });
    // Drop the cached deviceId so any in-flight access tokens with the
    // old `did` fail their JwtStrategy device-binding check immediately
    // (no need to wait the 15-min access-token TTL).
    await this.redis.del(CacheKeys.activeDeviceId(userId));
  }

  /** Logout from all devices — same action because only one session exists. */
  async logoutAll(userId: string): Promise<void> {
    await this.sessionsRepo.delete({ userId });
    await this.redis.del(CacheKeys.activeDeviceId(userId));
  }
}
