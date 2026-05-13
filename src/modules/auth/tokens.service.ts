import { randomUUID } from 'crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
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
    await this.redis.setJson(
      cacheKey,
      { status: sub.status, expiresAt: expiresAtIso },
      600,
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

    // Single-device enforcement: replace any existing session for this user.
    await this.sessionsRepo.delete({ userId: user.id });
    await this.sessionsRepo.insert({
      userId: user.id,
      deviceId: opts.deviceId,
      deviceName: opts.deviceName ?? null,
      refreshTokenJti: refreshJti,
      ipAddress: opts.ip ?? null,
    });

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
  }

  /** Logout from all devices — same action because only one session exists. */
  async logoutAll(userId: string): Promise<void> {
    await this.sessionsRepo.delete({ userId });
  }
}
