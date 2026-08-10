import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import { Partner } from './entities/partner.entity';

/**
 * Parameter decorator that returns the Partner row PartnerAuthGuard
 * stamped onto the request. Controllers gate with the guard and
 * receive the row without an extra query.
 */
export const CurrentPartner = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Partner => {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { partner?: Partner }>();
    if (!req.partner) {
      throw new Error(
        'CurrentPartner used without PartnerAuthGuard mounting the request.',
      );
    }
    return req.partner;
  },
);
