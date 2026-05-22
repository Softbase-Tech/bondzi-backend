import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Request } from 'express';
import { REQUIRES_SUBSCRIPTION_KEY } from '../decorators/subscription.decorator';
import { Subscription } from '../../modules/subscriptions/entities/subscription.entity';
import { SubscriptionStatus } from '../types/enums';
import { RedisService } from '../redis/redis.service';
import { CacheKeys } from '../utils/cache-keys.util';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';

interface CachedStatus {
  id: string;
  status: SubscriptionStatus;
  expiresAt: string | null;
}

/**
 * Enforces an active subscription on routes decorated with @RequiresSubscription().
 * Order: Redis cache → DB fallback → 402/403.
 */
@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectRepository(Subscription)
    private readonly subscriptionsRepo: Repository<Subscription>,
    private readonly redis: RedisService,
    private readonly cfg: ConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean>(
      REQUIRES_SUBSCRIPTION_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!required) return true;

    const req = ctx
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    const userId = req.user?.id;
    if (!userId) throw new ForbiddenException('Authentication required');

    const cacheKey = CacheKeys.subscriptionStatus(userId);
    const cached = await this.redis.getJson<CachedStatus>(cacheKey);

    if (cached) {
      if (this.isActive(cached.status, cached.expiresAt)) return true;
      throw new ForbiddenException('Active subscription required');
    }

    // CRITICAL: filter to access-eligible statuses BEFORE ordering by
    // createdAt. Without this, a recent PAST_DUE row (every "tap Start
    // with X but didn't pay" creates one — see SubscriptionsService.
    // initiate) becomes the newest sub for the user and would poison the
    // guard: it'd see a PAST_DUE row, declare "not active", and 403
    // every paywalled endpoint even if the user has a VALID, ACTIVE row
    // sitting one createdAt-position behind it. Restricting to the three
    // grant statuses + the future-expiry predicate keeps PAST_DUE /
    // CANCELLED / EXPIRED rows from clobbering the lookup.
    const sub = await this.subscriptionsRepo
      .createQueryBuilder('s')
      .where('s.user_id = :uid', { uid: userId })
      .andWhere("s.status IN ('active','trial','xp_credited')")
      .andWhere('(s.expires_at IS NULL OR s.expires_at > NOW())')
      .orderBy('s.expires_at', 'DESC')
      .getOne();

    if (!sub) throw new ForbiddenException('Active subscription required');

    const expiresAt = sub.expiresAt ? sub.expiresAt.toISOString() : null;
    const payload: CachedStatus = {
      id: sub.id,
      status: sub.status,
      expiresAt,
    };
    // TTL bounded by SUBSCRIPTION_STATUS_CACHE_TTL — see app.config.ts.
    // Cancellation impact on free-premium leak is capped at this value.
    const ttl = this.cfg.get<number>('app.subscriptionStatusCacheTtlSec') ?? 60;
    await this.redis.setJson(cacheKey, payload, ttl);

    if (!this.isActive(sub.status, expiresAt)) {
      throw new ForbiddenException('Active subscription required');
    }
    return true;
  }

  private isActive(
    status: SubscriptionStatus,
    expiresAtIso: string | null,
  ): boolean {
    if (
      status !== SubscriptionStatus.ACTIVE &&
      status !== SubscriptionStatus.TRIAL &&
      status !== SubscriptionStatus.XP_CREDITED
    )
      return false;
    if (!expiresAtIso) return status === SubscriptionStatus.ACTIVE;
    return new Date(expiresAtIso).getTime() > Date.now();
  }
}
