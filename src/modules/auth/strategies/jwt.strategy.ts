import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Repository } from 'typeorm';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { ExamType, UserRole } from '../../../common/types/enums';
import { RedisService } from '../../../common/redis/redis.service';
import { CacheKeys } from '../../../common/utils/cache-keys.util';
import { DeviceSession } from '../entities/device-session.entity';

interface AccessTokenPayload {
  sub: string;
  email: string | null;
  phone: string | null;
  role: UserRole;
  examType?: ExamType;
  subscriptionStatus?: string;
  jti: string;
  /** Device id bound to this token at issuance time (single-device enforcement). */
  did?: string;
  /** Standard JWT expiry (unix seconds). Populated by passport-jwt's decode. */
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly redis: RedisService,
    @InjectRepository(DeviceSession)
    private readonly sessionsRepo: Repository<DeviceSession>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.accessSecret') as string,
    });
  }

  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    // Revoked access tokens (logout) are tracked in Redis with a TTL
    // matching the token expiry. Missing Redis should never silently
    // admit a revoked JTI, but we degrade to "trust the signature" if
    // the cache layer is down.
    if (payload.jti) {
      const revoked = await this.redis.get(CacheKeys.revokedJti(payload.jti));
      if (revoked) throw new UnauthorizedException('Token revoked');
    }

    // Device-binding check: every access token carries a `did` claim
    // identifying the `device_sessions` row it was issued for. If the
    // (user, device) row was deleted (single-device logout, logoutAll,
    // password reset), the corresponding token stops working
    // immediately — no waiting on the 15-min TTL.
    //
    // Two-tier check: Redis presence marker first (sub-ms), DB row
    // fallback on cache miss. A token without a `did` claim is a
    // legacy issuance from before device binding existed — accept it;
    // the next refresh mints a properly bound pair.
    if (payload.did) {
      const ok = await this.isDeviceBindingValid(payload.sub, payload.did);
      if (!ok) {
        throw new UnauthorizedException({
          code: 'DEVICE_KICKED',
          message: 'This device was signed out. Please sign in again.',
        });
      }
    }

    return {
      id: payload.sub,
      email: payload.email,
      phone: payload.phone,
      role: payload.role,
      examType: payload.examType,
      subscriptionStatus: payload.subscriptionStatus,
      jti: payload.jti,
      did: payload.did,
      // Pass the raw expiry through so callers that need to revoke
      // this exact token (e.g. examType rotation) can compute the
      // Redis TTL without re-decoding the JWT.
      exp: payload.exp,
    };
  }

  private async isDeviceBindingValid(
    userId: string,
    claimedDeviceId: string,
  ): Promise<boolean> {
    // Per-device cache marker: presence of the key = the (user,
    // device) session is live. Absence = check the DB.
    const cached = await this.redis.getJson<string>(
      CacheKeys.activeDeviceId(userId, claimedDeviceId),
    );
    if (typeof cached === 'string' && cached.length > 0) {
      return true;
    }
    // Cache miss — the DB is the source of truth. The (userId,
    // deviceId) UNIQUE index makes this a single-row primary-key
    // lookup, so it's cheap.
    const session = await this.sessionsRepo.findOne({
      where: { userId, deviceId: claimedDeviceId },
      select: { id: true },
    });
    if (!session) return false;
    // Re-warm the cache (best-effort). Next token issuance refreshes
    // it anyway; we just avoid another DB hit until then.
    await this.redis
      .setJson(
        CacheKeys.activeDeviceId(userId, claimedDeviceId),
        '1',
        15 * 60,
      )
      .catch(() => undefined);
    return true;
  }
}
