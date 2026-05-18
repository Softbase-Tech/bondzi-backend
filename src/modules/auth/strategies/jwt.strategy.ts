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
    // identifying the `device_sessions` row it was issued for. After a
    // DEVICE_KICKED event the old token's `did` no longer matches the
    // active session, and the rightful owner's "force-logout via new
    // login" guarantee is preserved without waiting for the 15-min
    // access-token TTL.
    //
    // Two-tier check: Redis-cached deviceId first (sub-ms), DB row only
    // on cache miss. A token without a `did` claim is a legacy issuance
    // from before this binding existed — accept it; the next refresh
    // will mint a properly bound pair.
    if (payload.did) {
      const ok = await this.isDeviceBindingValid(payload.sub, payload.did);
      if (!ok) {
        throw new UnauthorizedException({
          code: 'DEVICE_KICKED',
          message: 'Your account was signed in on another device.',
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
    };
  }

  private async isDeviceBindingValid(
    userId: string,
    claimedDeviceId: string,
  ): Promise<boolean> {
    const cached = await this.redis.getJson<string>(
      CacheKeys.activeDeviceId(userId),
    );
    if (typeof cached === 'string' && cached.length > 0) {
      return cached === claimedDeviceId;
    }
    // Cache miss — fall back to the source of truth and re-warm the
    // cache (best-effort; the next token issuance refreshes it anyway).
    const session = await this.sessionsRepo.findOne({
      where: { userId },
      select: { id: true, deviceId: true },
    });
    if (!session) return false;
    await this.redis
      .setJson(CacheKeys.activeDeviceId(userId), session.deviceId, 15 * 60)
      .catch(() => undefined);
    return session.deviceId === claimedDeviceId;
  }
}
