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
   * Stale-tolerable: if a webhook / XP redemption flips status mid-session,
   * the refresh-token rotation will pick the new value up.
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
