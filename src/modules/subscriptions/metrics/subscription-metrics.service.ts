import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subscription } from '../entities/subscription.entity';

export interface MrrBreakdown {
  /**
   * Monthly recurring revenue: the monthly-normalised value of every
   * recurring subscription that is expected to bill again.
   */
  mrrGhs: number;
  /**
   * Monthly value of subscriptions that are cancelled but still inside
   * their paid term. They deliver access today and bill nothing next
   * cycle — the amount MRR is about to lose, absent a win-back.
   */
  pendingChurnGhs: number;
  /** Count behind `mrrGhs`. The denominator for ARPPU. */
  payingRecurringSubs: number;
  /** Count behind `pendingChurnGhs`. */
  cancelledStillEntitled: number;
}

export interface EntitledProCounts {
  /** Entitled to Pro AND paying for it — the unit-economics denominator. */
  paying: number;
  /**
   * Everyone entitled to Pro, including admin comps (`provider='manual'`)
   * and XP-credited grants. The number that predicts AI cost.
   */
  totalEntitled: number;
}

/**
 * The single source of truth for subscription money metrics.
 *
 * This exists because the admin dashboard and the monthly report must not
 * be able to disagree. The dashboard previously computed MRR as
 * `SUM(subscriptions.amount_ghs) WHERE status = 'active'`, which is wrong
 * in three independent ways:
 *
 *   1. `amount_ghs` is the amount *charged*, not the monthly value. An
 *      annual subscription contributes twelve months of revenue in one
 *      row, so it counted at 12x its true MRR.
 *   2. A lifetime Plus purchase is a one-time charge with no recurrence,
 *      yet it stayed in the sum forever — MRR that can never be billed
 *      again.
 *   3. Admin comps (`provider = 'manual'`) and XP-credited grants have no
 *      cash behind them at all, and both sat in the total.
 *
 * The corrected figure normalises through `subscription_plan.monthly_price`
 * and counts only what will actually bill again.
 *
 * **Entitlement predicate.** The "still live" clause mirrors
 * `SubscriptionsService.entitlementFor()` exactly, including the
 * cancellation grace rule (a cancelled row keeps access until its paid
 * term lapses). If the two drift, the report and the app will disagree
 * about who is a paying customer, which is the specific failure this
 * service exists to prevent.
 *
 * **Why cancelled rows are excluded from MRR but reported separately.**
 * MRR is forward-looking: a cancelled subscription will not bill next
 * cycle, so including it overstates recurring revenue. But dropping it
 * silently hides an imminent loss, so it is returned as
 * `pendingChurnGhs`. Reporting both makes the judgement visible rather
 * than buried in a WHERE clause.
 */
@Injectable()
export class SubscriptionMetricsService {
  constructor(
    @InjectRepository(Subscription)
    private readonly subsRepo: Repository<Subscription>,
  ) {}

  /**
   * `asOf` lets a backfilled snapshot recompute a past day. Defaults to
   * now. Note the result is only as historically accurate as the row's
   * `expires_at`/status allow — status is overwritten in place, so a
   * far-past `asOf` reflects today's statuses, not that day's. Same-day
   * and recent use is exact; deep backfill is approximate and the caller
   * should mark it so.
   */
  async mrr(asOf: Date = new Date()): Promise<MrrBreakdown> {
    const row = await this.subsRepo
      .createQueryBuilder('s')
      .innerJoin('subscription_plan', 'p', 'p.id = s.plan_id')
      // Only recurring plans can produce recurring revenue. One-time
      // (lifetime Plus) purchases are revenue, but not *monthly* revenue.
      .where(`p.payment_kind = 'recurring'`)
      // No cash behind either of these.
      .andWhere(`s.provider IS DISTINCT FROM 'manual'`)
      .andWhere(`s.status <> 'xp_credited'`)
      // Mirror of entitlementFor(): live grant set + not lapsed.
      .andWhere(
        `(
           s.status IN ('active','trial')
           OR (s.status = 'cancelled' AND s.expires_at > :asOf)
         )`,
        { asOf },
      )
      .andWhere('(s.expires_at IS NULL OR s.expires_at > :asOf)', { asOf })
      .select(
        `COALESCE(SUM(p.monthly_price) FILTER (WHERE s.status IN ('active','trial')), 0)`,
        'mrr',
      )
      .addSelect(
        `COALESCE(SUM(p.monthly_price) FILTER (WHERE s.status = 'cancelled'), 0)`,
        'pending_churn',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE s.status IN ('active','trial'))`,
        'paying_subs',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE s.status = 'cancelled')`,
        'cancelled_subs',
      )
      .getRawOne<{
        mrr: string;
        pending_churn: string;
        paying_subs: string;
        cancelled_subs: string;
      }>();

    return {
      mrrGhs: round2(parseFloat(row?.mrr ?? '0')),
      pendingChurnGhs: round2(parseFloat(row?.pending_churn ?? '0')),
      payingRecurringSubs: parseInt(row?.paying_subs ?? '0', 10),
      cancelledStillEntitled: parseInt(row?.cancelled_subs ?? '0', 10),
    };
  }

  /**
   * Pro headcount, split by whether money is behind it.
   *
   * Both numbers matter and they answer different questions: `paying`
   * divides revenue, `totalEntitled` divides AI cost — a comped account
   * consumes exactly as many tokens as a paying one.
   */
  async entitledPro(asOf: Date = new Date()): Promise<EntitledProCounts> {
    const row = await this.subsRepo
      .createQueryBuilder('s')
      .innerJoin('subscription_plan', 'p', 'p.id = s.plan_id')
      .where(`p.account = 'pro'`)
      .andWhere(
        `(
           s.status IN ('active','trial','xp_credited')
           OR (s.status = 'cancelled' AND s.expires_at > :asOf)
         )`,
        { asOf },
      )
      .andWhere('(s.expires_at IS NULL OR s.expires_at > :asOf)', { asOf })
      .select('COUNT(DISTINCT s.user_id)', 'total')
      .addSelect(
        `COUNT(DISTINCT s.user_id) FILTER (
           WHERE s.provider IS DISTINCT FROM 'manual' AND s.status <> 'xp_credited'
         )`,
        'paying',
      )
      .getRawOne<{ total: string; paying: string }>();

    return {
      paying: parseInt(row?.paying ?? '0', 10),
      totalEntitled: parseInt(row?.total ?? '0', 10),
    };
  }
}

/** GHS is a 2-decimal currency; float sums drift without this. */
function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}
