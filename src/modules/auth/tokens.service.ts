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
import { AccountType, ExamType } from '../../common/types/enums';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}

/**
 * How long the OUTGOING refresh-token JTI keeps working after rotation.
 *
 * Covers the mobile client's response-loss window — force-quit
 * mid-response, TCP reset, cellular flap between our commit and their
 * setPair. 60 s is long enough for every honest race we've seen in the
 * wild and short enough that a stolen refresh-token still only gets ONE
 * one-minute window to be used before the rightful client's next
 * rotation invalidates it.
 */
const REFRESH_TOKEN_GRACE_MS = 60 * 1000;

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
    private readonly subscriptions: SubscriptionsService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Cached subscription-status lookup for JWT stamping. Resolves to the
   * user's account on their CURRENT level — Plus/Pro on SHS doesn't
   * surface as "active" in a JWT issued while they're on NOVDEC.
   *
   * Status is the canonical short string that mobile branches on:
   *   - `'free'` — no Plus/Pro on this level (or no examType set)
   *   - `'plus'` — Plus on this level (lifetime)
   *   - `'pro'`  — Pro on this level (recurring, currently active)
   *   - `'expired'` — there was a row but it's lapsed (UI shows "renew")
   *
   * Marked as a UI hint only — see AuthenticatedUser.subscriptionStatus
   * for the authz disclaimer.
   */
  private async currentSubscriptionStatus(
    userId: string,
    examType: ExamType | null | undefined,
  ): Promise<string> {
    // Pre-onboarding (no examType): nothing to gate against — surface free.
    if (!examType) return 'free';
    const ent = await this.subscriptions.entitlementFor(userId, examType);
    if (ent.account === AccountType.FREE) {
      // Could still be a previously-expired row; surface 'expired' so the
      // UI can prompt renewal. Cheaper signal than re-querying the latest
      // subscription row for an explicit status.
      return 'free';
    }
    if (ent.expiresAt && ent.expiresAt.getTime() <= Date.now()) {
      return 'expired';
    }
    return ent.account;
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

    const subscriptionStatus = await this.currentSubscriptionStatus(
      user.id,
      user.examType,
    );

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
    //
    // Rotation grace: when the ON CONFLICT branch fires (an existing
    // session is being rotated), stash the pre-update refresh_token_jti
    // into previous_refresh_jti and stamp previous_jti_expires_at
    // REFRESH_TOKEN_GRACE_MS in the future. rotate() will still accept
    // the stashed jti during that window so a client that never got the
    // freshly-minted pair (force-quit mid-response, TCP reset, cellular
    // flap) isn't locked out. `device_sessions.column` in the SET clause
    // reads the row's PRE-update value, `EXCLUDED.column` reads the
    // incoming value — this is the only way to move current → previous
    // in a single atomic statement.
    const graceIntervalSql = `${Math.floor(REFRESH_TOKEN_GRACE_MS / 1000)} seconds`;
    await this.sessionsRepo.manager.query(
      `
      INSERT INTO device_sessions (
        user_id, device_id, device_name, refresh_token_jti, ip_address
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id) DO UPDATE SET
        previous_refresh_jti = device_sessions.refresh_token_jti,
        previous_jti_expires_at = now() + $6::interval,
        device_id = EXCLUDED.device_id,
        device_name = EXCLUDED.device_name,
        refresh_token_jti = EXCLUDED.refresh_token_jti,
        ip_address = EXCLUDED.ip_address
      `,
      [
        user.id,
        opts.deviceId,
        opts.deviceName ?? null,
        refreshJti,
        opts.ip ?? null,
        graceIntervalSql,
      ],
    );

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
    if (!session) {
      throw new UnauthorizedException({
        code: 'DEVICE_KICKED',
        message: 'Your account was signed in on another device.',
      });
    }

    // Accept EITHER the current jti (normal path) OR the previous jti
    // if we're still inside the rotation grace window. Race the same
    // request twice, kill the app mid-response, cellular flap — none of
    // those should force the user to sign back in.
    const matchesCurrent = session.refreshTokenJti === payload.jti;
    const withinGrace =
      session.previousRefreshJti === payload.jti &&
      session.previousJtiExpiresAt !== null &&
      session.previousJtiExpiresAt.getTime() > Date.now();
    if (!matchesCurrent && !withinGrace) {
      throw new UnauthorizedException({
        code: 'DEVICE_KICKED',
        message: 'Your account was signed in on another device.',
      });
    }
    if (!matchesCurrent && withinGrace) {
      this.logger.log(
        `[auth] refresh accepted via grace window user=${payload.sub} ` +
          `graceMs=${session.previousJtiExpiresAt!.getTime() - Date.now()}`,
      );
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
