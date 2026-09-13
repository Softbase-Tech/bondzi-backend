import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BaseCollector, count, num } from './base.collector';
import type {
  CollectorResult,
  MetricCollector,
  RevenueMetrics,
} from './collector.types';
import { ratio } from '../constants/thresholds';
import { dayBounds, type DateRange } from '../date-range.util';
import { SubscriptionMetricsService } from '../../subscriptions/metrics/subscription-metrics.service';

/**
 * Money.
 *
 * `payment_attempts` is the strongest table in the schema for reporting:
 * a row is written *before* Paystack is contacted, so abandoned checkouts
 * are captured rather than invisible, and each status carries its own
 * timestamp.
 *
 * **Success rate counts only terminal attempts.** `pending` rows are
 * excluded, which is only correct because the Phase 0 sweep job now flips
 * stale ones to `abandoned` after 24h. Without that sweep, abandonment
 * would sit `pending` forever and quietly shrink the denominator — making
 * the reported success rate climb exactly as real abandonment got worse.
 *
 * MRR, pending churn and the Pro headcount come from
 * `SubscriptionMetricsService` rather than being recomputed here, so this
 * report and the admin dashboard are incapable of disagreeing.
 */
@Injectable()
export class RevenueCollector
  extends BaseCollector
  implements MetricCollector<RevenueMetrics>
{
  readonly key = 'revenue';

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly subMetrics: SubscriptionMetricsService,
  ) {
    super();
  }

  async collect(range: DateRange): Promise<CollectorResult<RevenueMetrics>> {
    return this.run<RevenueMetrics>(async (errors) => {
      const { from, to } = dayBounds(range.start);

      const attempts = await this.guard(
        'revenue.attempts',
        errors,
        () =>
          this.ds.query<
            Array<{ terminal: string; succeeded: string; revenue: string }>
          >(
            // Terminal states only. `initiated_at` bounds the denominator
            // (demand on this day) while `paid_at` bounds revenue, because
            // an attempt initiated at 23:59 may settle after midnight and
            // belongs to the day the money actually arrived.
            `SELECT COUNT(*) FILTER (
                      WHERE initiated_at >= $1 AND initiated_at < $2
                        AND status IN ('paid','failed','abandoned')
                    ) AS terminal,
                    COUNT(*) FILTER (
                      WHERE paid_at >= $1 AND paid_at < $2 AND status = 'paid'
                    ) AS succeeded,
                    COALESCE(SUM(amount_ghs) FILTER (
                      WHERE paid_at >= $1 AND paid_at < $2 AND status = 'paid'
                    ), 0) AS revenue
               FROM payment_attempts`,
            [from, to],
          ),
        [],
      );
      const terminal = attempts[0] ? count(attempts[0].terminal) : null;
      const succeeded = attempts[0] ? count(attempts[0].succeeded) : null;

      // First-ever paid charge per user, on a Pro plan. Sourced from
      // payment_attempts rather than subscriptions so admin comps
      // (provider='manual') and XP-credited grants are excluded by
      // construction — neither ever touches the payments table.
      const newPro = await this.guard(
        'revenue.new_pro',
        errors,
        () =>
          this.ds.query<Array<{ n: string }>>(
            `SELECT COUNT(*) AS n FROM (
               SELECT pa.user_id, MIN(pa.paid_at) AS first_paid
                 FROM payment_attempts pa
                 JOIN subscription_plan p ON p.id = pa.plan_id
                WHERE pa.status = 'paid' AND p.account = 'pro'
                GROUP BY pa.user_id
             ) f
             WHERE f.first_paid >= $1 AND f.first_paid < $2`,
            [from, to],
          ),
        [],
      );

      // Churn split. Both halves are now recordable: cancelled_at was
      // added in Phase 0, and a cancelled row is never swept into expired
      // (the renewal cron only considers active/trial/xp_credited), so the
      // two are genuinely distinct rather than one masking the other.
      const churn = await this.guard(
        'revenue.churn',
        errors,
        () =>
          this.ds.query<Array<{ cancelled: string; expired: string }>>(
            `SELECT COUNT(*) FILTER (
                      WHERE cancelled_at >= $1 AND cancelled_at < $2
                    ) AS cancelled,
                    COUNT(*) FILTER (
                      WHERE status = 'expired'
                        AND expires_at >= $1 AND expires_at < $2
                    ) AS expired
               FROM subscriptions`,
            [from, to],
          ),
        [],
      );

      const xp = await this.guard(
        'revenue.xp',
        errors,
        () =>
          this.ds.query<Array<{ n: string; days: string }>>(
            // XP redemption is a real liability: it grants paid access for
            // no cash. Tracked here so the cost of the XP economy stays
            // visible next to the revenue it substitutes for.
            `SELECT COUNT(*) AS n, COALESCE(SUM(credit_days),0) AS days
               FROM xp_redemptions
              WHERE applied_at >= $1 AND applied_at < $2`,
            [from, to],
          ),
        [],
      );

      const asOf = to;
      const mrr = await this.guard(
        'revenue.mrr',
        errors,
        () => this.subMetrics.mrr(asOf),
        null,
      );
      const pro = await this.guard(
        'revenue.active_pro',
        errors,
        () => this.subMetrics.entitledPro(asOf),
        null,
      );

      return {
        charges_attempted: terminal,
        charges_succeeded: succeeded,
        payment_success_rate: ratio(succeeded, terminal),
        revenue_ghs: attempts[0] ? num(attempts[0].revenue) : null,
        new_pro_subs: newPro[0] ? count(newPro[0].n) : null,
        cancellations: churn[0] ? count(churn[0].cancelled) : null,
        expiries: churn[0] ? count(churn[0].expired) : null,
        active_pro_paying: pro ? pro.paying : null,
        active_pro_entitled: pro ? pro.totalEntitled : null,
        mrr_ghs: mrr ? mrr.mrrGhs : null,
        pending_churn_ghs: mrr ? mrr.pendingChurnGhs : null,
        xp_redemptions: xp[0] ? count(xp[0].n) : null,
        xp_credit_days: xp[0] ? count(xp[0].days) : null,
      };
    });
  }
}
