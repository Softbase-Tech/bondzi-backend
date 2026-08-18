import { randomUUID } from 'crypto';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { DeviceSession } from './entities/device-session.entity';
import { AuthLoginEvent } from './entities/auth-login-event.entity';
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
 * v3 token issuance with PER-DEVICE session enforcement.
 *
 * `device_sessions` holds at most one row per (user_id, device_id) —
 * a student can be signed in on web + mobile + tablet simultaneously.
 * Each device's row rotates independently on refresh; a re-login for
 * the same (user, device) UPSERTs that one row only.
 *
 * A refresh token carries (userId, jti, deviceId). On rotation we
 * verify that (userId, deviceId, jti) still resolves to a session
 * row. Missing row → DEVICE_KICKED (that specific device was
 * logged out, OR a password reset nuked every session).
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
    opts: {
      deviceId: string;
      deviceName?: string;
      ip?: string;
      /** Platform this sign-in came from ('web'|'ios'|'android'|null). */
      platform?: string | null;
      /**
       * When set, records a row in `auth_login_events` for this sign-in.
       * Omitted for refresh-token rotation / exam-type re-issue, which
       * re-issue tokens but are not new logins.
       */
      loginEvent?: 'register' | 'login' | 'google' | 'otp';
    },
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

    // Per-device enforcement: atomic UPSERT keyed by (user_id, device_id).
    // Two simultaneous logins for the same account on different devices
    // insert two separate rows; two simultaneous logins for the same
    // (user, device) UPSERT the single row.
    //
    // Rotation grace: when the ON CONFLICT branch fires (existing row
    // for THIS device being rotated), stash the pre-update
    // refresh_token_jti into previous_refresh_jti and stamp
    // previous_jti_expires_at REFRESH_TOKEN_GRACE_MS in the future.
    // rotate() will still accept the stashed jti during that window so
    // a client that never got the freshly-minted pair (force-quit
    // mid-response, TCP reset, cellular flap) isn't locked out.
    // `device_sessions.column` in the SET clause reads the row's
    // PRE-update value, `EXCLUDED.column` reads the incoming value —
    // this is the only way to move current → previous in a single
    // atomic statement.
    const graceIntervalSql = `${Math.floor(REFRESH_TOKEN_GRACE_MS / 1000)} seconds`;
    await this.sessionsRepo.manager.query(
      `
      INSERT INTO device_sessions (
        user_id, device_id, device_name, refresh_token_jti, ip_address
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, device_id) DO UPDATE SET
        previous_refresh_jti = device_sessions.refresh_token_jti,
        previous_jti_expires_at = now() + $6::interval,
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

    // Cache the deviceId as an active-session marker so JwtStrategy can
    // reject access tokens for logged-out devices without a DB round-trip.
    // Key is per-device so a logout on device A doesn't invalidate the
    // marker for device B. TTL matches the access-token window.
    await this.redis.setJson(
      CacheKeys.activeDeviceId(user.id, opts.deviceId),
      '1',
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

    // Append-only login history with the platform. Only for real sign-ins
    // (loginEvent set) — refresh/exam-type rotations skip this. Best-effort:
    // a failed insert must never block issuing the token pair.
    if (opts.loginEvent) {
      try {
        await this.sessionsRepo.manager.getRepository(AuthLoginEvent).insert({
          userId: user.id,
          platform: opts.platform ?? null,
          eventType: opts.loginEvent,
          deviceId: opts.deviceId,
          ipAddress: opts.ip ?? null,
        });
      } catch (err) {
        this.logger.warn(
          `[auth] login-event insert failed user=${user.id}: ${(err as Error).message}`,
        );
      }
    }

    return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
  }

  /**
   * Exchange a refresh token for a new pair. Returns 401 DEVICE_KICKED
   * when the session for this specific (user, device) has been
   * revoked — either by an explicit logout on that device, a
   * password reset, or an admin action. Other devices for the same
   * user are unaffected.
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

    // Look up strictly the (user, device) row this refresh token
    // belongs to. Under per-device enforcement, another device's row
    // being present must never authorise a stale token from a
    // different device — even if the JTI happened to match.
    const session = await this.sessionsRepo.findOne({
      where: { userId: payload.sub, deviceId: payload.did },
    });
    if (!session) {
      throw new UnauthorizedException({
        code: 'DEVICE_KICKED',
        message: 'This device was signed out. Please sign in again.',
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
        message: 'This device was signed out. Please sign in again.',
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
      // Trust the JWT-verified deviceId (payload.did was matched
      // against the session row we just resolved). session.deviceId
      // would be identical here — we prefer payload.did as a defence
      // against any future refactor that widens the WHERE clause.
      deviceId: payload.did,
      deviceName: session.deviceName ?? undefined,
      ip: opts.ip,
    });
  }

  /** Blacklist an access-token JTI until it expires (for logout). */
  async revokeByAccessJti(jti: string, expiresAtUnix: number): Promise<void> {
    const ttl = Math.max(1, expiresAtUnix - Math.floor(Date.now() / 1000));
    await this.redis.setJson(CacheKeys.revokedJti(jti), '1', ttl);
  }

  /**
   * Logout ONE device — delete the (user, device) row. Other devices
   * signed into the same account are unaffected.
   *
   * `deviceId` is optional to keep older callers compiling; when
   * omitted we fall back to logoutAll semantics (delete every row).
   * All in-tree callers should pass a deviceId now.
   */
  async logoutUser(userId: string, deviceId?: string): Promise<void> {
    if (deviceId) {
      await this.sessionsRepo.delete({ userId, deviceId });
      await this.redis.del(CacheKeys.activeDeviceId(userId, deviceId));
      return;
    }
    // No deviceId supplied — fall back to full sign-out. Safer than
    // a silent no-op.
    await this.logoutAll(userId);
  }

  /**
   * Nuke every session for the user across every device. Used on
   * password reset and the explicit "sign out everywhere" affordance.
   */
  async logoutAll(userId: string): Promise<void> {
    const sessions = await this.sessionsRepo.find({
      where: { userId },
      select: { deviceId: true },
    });
    await this.sessionsRepo.delete({ userId });
    // Drop every per-device cache marker so any in-flight access token
    // with a `did` claim for this user fails its JwtStrategy check
    // without waiting for the 15-min TTL to lapse.
    await Promise.all(
      sessions.map((s) =>
        this.redis.del(CacheKeys.activeDeviceId(userId, s.deviceId)),
      ),
    );
  }
}
