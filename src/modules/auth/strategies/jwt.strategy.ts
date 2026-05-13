import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { ExamType, UserRole } from '../../../common/types/enums';
import { RedisService } from '../../../common/redis/redis.service';
import { CacheKeys } from '../../../common/utils/cache-keys.util';

interface AccessTokenPayload {
  sub: string;
  email: string | null;
  phone: string | null;
  role: UserRole;
  examType?: ExamType;
  subscriptionStatus?: string;
  jti: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly redis: RedisService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.accessSecret') as string,
    });
  }

  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    // Revoked access tokens (logout) are tracked in Redis with a TTL matching
    // the token expiry. Missing Redis should never silently admit a revoked JTI,
    // but we degrade to "trust the signature" if the cache layer is down.
    if (payload.jti) {
      const revoked = await this.redis.get(CacheKeys.revokedJti(payload.jti));
      if (revoked) throw new UnauthorizedException('Token revoked');
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
}
