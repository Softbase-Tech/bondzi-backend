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
import { SubscriptionPlanEntity } from '../../modules/subscriptions/plans/entities/subscription-plan.entity';
import { AccountType, SubscriptionStatus } from '../types/enums';
import { RedisService } from '../redis/redis.service';
import { CacheKeys } from '../utils/cache-keys.util';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';

interface CachedEntitlement {
  account: AccountType;
  expiresAt: string | null;
  subscriptionId: string | null;
}

/**
 * Enforces a Plus/Pro entitlement on routes decorated with
 * @RequiresSubscription() — gated PER LEVEL, against the user's current
 * `examType` from the JWT.
 *
 * Order: Redis cache → DB fallback → 403.
 *
 * Why per-level: under the new account model, Plus and Pro are purchased
 * separately for BECE, WASSCE and NOVDEC. A user with Plus on SHS who
 * switches their profile to NOVDEC must hit Free for NOVDEC content —
 * the guard must reflect that even though they DO have a paid plan on
 * some other level.
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

    const examType = req.user?.examType;
    // No examType means the user hasn't finished onboarding. Paid routes
    // are not reachable in that state.
    if (!examType) {
      throw new ForbiddenException(
        'Complete onboarding before accessing premium features.',
      );
    }

    const cacheKey = CacheKeys.entitlement(userId, examType);
    const cached = await this.redis.getJson<CachedEntitlement>(cacheKey);

    if (cached) {
      if (this.entitlementGrants(cached.account, cached.expiresAt)) return true;
      throw new ForbiddenException(
        'Active subscription required for this level.',
      );
    }

    // CRITICAL: filter to access-eligible statuses BEFORE ordering. A
    // recent PAST_DUE row (every "tap Start, didn't pay" creates one)
    // would otherwise shadow an active row and 403 a paid user.
    // Restricting to grant statuses + future-expiry + level-match keeps
    // PAST_DUE / CANCELLED / EXPIRED / REFUNDED rows from clobbering the
    // lookup. The plan join enforces the level filter.
    const sub = await this.subscriptionsRepo
      .createQueryBuilder('s')
      .innerJoin(
        SubscriptionPlanEntity,
        'p',
        'p.id = s.plan_id AND p.level = :level',
        { level: examType },
      )
      .where('s.user_id = :uid', { uid: userId })
      .andWhere("s.status IN ('active','trial','xp_credited')")
      .andWhere('(s.expires_at IS NULL OR s.expires_at > NOW())')
      .select([
        's.id AS id',
        's.expires_at AS expires_at',
        'p.account AS account',
      ])
      .orderBy(
        `CASE p.account WHEN 'pro' THEN 2 WHEN 'plus' THEN 1 ELSE 0 END`,
        'DESC',
      )
      .addOrderBy('s.expires_at', 'DESC', 'NULLS FIRST')
      .limit(1)
      .getRawOne<{ id: string; expires_at: Date | null; account: AccountType }>();

    if (!sub) {
      throw new ForbiddenException(
        'Active subscription required for this level.',
      );
    }

    const expiresAtIso = sub.expires_at ? sub.expires_at.toISOString() : null;
    const payload: CachedEntitlement = {
      account: sub.account,
      expiresAt: expiresAtIso,
      subscriptionId: sub.id,
    };
    // TTL bounded by SUBSCRIPTION_STATUS_CACHE_TTL — see app.config.ts.
    // Refund / cancel impact on free-premium leak is capped at this value;
    // the entitlement cache is also explicitly invalidated by
    // SubscriptionsService.invalidateEntitlementCache after those events.
    const ttl = this.cfg.get<number>('app.subscriptionStatusCacheTtlSec') ?? 60;
    await this.redis.setJson(cacheKey, payload, ttl);

    if (!this.entitlementGrants(sub.account, expiresAtIso)) {
      throw new ForbiddenException(
        'Active subscription required for this level.',
      );
    }
    return true;
  }

  /**
   * Plus and Pro both grant access; Free does not. A NULL expires_at means
   * lifetime (Plus pattern) — always grants. A future expires_at grants
   * until that timestamp.
   */
  private entitlementGrants(
    account: AccountType,
    expiresAtIso: string | null,
  ): boolean {
    if (account === AccountType.FREE) return false;
    if (!expiresAtIso) return true;
    return new Date(expiresAtIso).getTime() > Date.now();
  }
}
