import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { ExamType, UserRole } from '../types/enums';

export interface AuthenticatedUser {
  id: string;
  email: string | null;
  phone: string | null;
  role: UserRole;
  examType?: ExamType;
  /**
   * Cached subscription status at token-issue time (spec §2.2). Possible
   * values mirror `subscriptions_status_enum` plus `'free'` for no sub.
   *
   * IMPORTANT: this is a UI hint only — NEVER use it for authorization.
   * SubscriptionGuard reads the fresh value from Redis (TTL controlled
   * by SUBSCRIPTION_STATUS_CACHE_TTL, default 60s). The JWT claim is
   * baked in at issue time and can be up to 15 minutes stale; using it
   * for an authz decision would let a cancelled / refunded user keep
   * premium access until their token expires. Clients may use this
   * value to show a premium badge or skip an extra /me round-trip.
   */
  subscriptionStatus?: string;
  jti?: string;
}

type RequestWithUser = Request & { user?: AuthenticatedUser };

/** Injects the JWT-authenticated user into a controller handler. */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<RequestWithUser>();
    const user = req.user;
    if (!user) return undefined;
    return data ? user[data] : user;
  },
);
