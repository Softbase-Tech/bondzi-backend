import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

interface RequestWithUser extends Request {
  user?: { id?: string };
}

/**
 * Replaces NestJS Throttler's default IP-only tracker with a
 * user-id-first tracker. When the JwtAuthGuard has populated
 * `req.user.id`, that id is the throttle key — so two students
 * behind the same NAT (school WiFi, shared mobile gateway) get
 * independent buckets and can each hit a rate-limited route at the
 * configured frequency.
 *
 * Unauthenticated routes (login, register, OTP) fall back to IP
 * because there's no user yet — same behaviour as the base
 * ThrottlerGuard for those calls.
 *
 * Registered globally via APP_GUARD, replacing the stock
 * ThrottlerGuard.
 */
@Injectable()
export class UserAwareThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as RequestWithUser;
    const userId = request.user?.id;
    if (typeof userId === 'string' && userId.length > 0) {
      return `user:${userId}`;
    }
    // Falls back to the parent implementation's IP-based tracker so
    // we don't accidentally collapse anonymous traffic into one
    // bucket.
    return super.getTracker(req);
  }
}
