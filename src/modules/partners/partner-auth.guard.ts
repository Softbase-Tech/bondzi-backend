import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Request } from 'express';
import { PartnerStatus } from '../../common/types/enums';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Partner } from './entities/partner.entity';

type RequestWithPartner = Request & {
  user?: AuthenticatedUser;
  partner?: Partner;
};

/**
 * Gates the `/partner/*` endpoints. Sits AFTER `JwtAuthGuard`
 * (so `req.user` is populated by passport-jwt) and checks that
 * the authenticated user has a `partners` row that isn't banned.
 *
 * On success the resolved Partner row is stamped onto
 * `req.partner` so controllers don't have to re-query.
 *
 * Rejects:
 *   - no user (missing JWT) → 403 (JwtAuthGuard would already have
 *     handled 401 upstream, this is belt-and-braces)
 *   - user has no partner row → 403 "Not a partner"
 *   - partner is banned → 403 "Account is banned"
 *
 * SUSPENDED partners CAN still read (`/partner/me`, list codes) so
 * they can appeal. Endpoints that mutate money or codes reject
 * suspended partners locally.
 */
@Injectable()
export class PartnerAuthGuard implements CanActivate {
  constructor(
    @InjectRepository(Partner)
    private readonly partnersRepo: Repository<Partner>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithPartner>();
    const user = req.user;
    if (!user) {
      throw new ForbiddenException('Authentication required.');
    }
    const partner = await this.partnersRepo.findOne({
      where: { userId: user.id },
    });
    if (!partner) {
      throw new ForbiddenException('This account is not a partner.');
    }
    if (partner.status === PartnerStatus.BANNED) {
      throw new ForbiddenException(
        'Your partner account has been closed. Contact support.',
      );
    }
    req.partner = partner;
    return true;
  }
}
