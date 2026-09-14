import type { DateRange } from '../date-range.util';

/**
 * A metric value that may legitimately be unknown.
 *
 * `null` is a first-class outcome, not an error: a ratio with a zero
 * denominator, a point-in-time metric on a backfilled day, a data source
 * that was unreachable. Renderers print `—` for it. The alternative —
 * coercing to 0 — is worse than useless, because "zero signups" and "we
 * could not count signups" demand opposite reactions.
 */
export type Metric = number | null;

export interface CollectorResult<T> {
  data: Partial<T>;
  /** Human-readable failures. One per thing that went wrong. */
  errors: string[];
  durationMs: number;
}

/**
 * Every collector implements this and **never throws**. A failure comes
 * back as a partial result plus an `errors` entry, so one broken data
 * source degrades its own section of the email rather than suppressing
 * the whole report. Silence is the one outcome the reporting system may
 * not produce.
 */
export interface MetricCollector<T> {
  readonly key: string;
  collect(range: DateRange): Promise<CollectorResult<T>>;
}

// ---------------------------------------------------------------------
// Metric shapes
// ---------------------------------------------------------------------

export interface GrowthMetrics {
  signups: Metric;
  signups_by_exam_type: Record<string, number>;
  signups_by_platform: Record<string, number>;
  signups_by_campaign: Record<string, number>;
  partner_attributed: Metric;
  referral_attributed: Metric;
  /** Cohort is `activated_cohort_date`, one day behind the snapshot. */
  activated: Metric;
  activation_rate: Metric;
  activated_cohort_date: string;
  activated_cohort_size: Metric;
  referrals_created: Metric;
  referrals_qualified: Metric;
  school_null_rate: Metric;
  school_distinct: Metric;
}

export interface EngagementMetrics {
  dau: Metric;
  wau: Metric;
  mau: Metric;
  dau_mau_ratio: Metric;
  practice_sessions: Metric;
  sessions_completed: Metric;
  sessions_completed_pct: Metric;
  questions_attempted: Metric;
  median_accuracy: Metric;
  mock_exams_taken: Metric;
  quiz_sessions: Metric;
  explanations_viewed: Metric;
  explanation_requests: Metric;
  streaks_active: Metric;
  top_subjects: Array<{ subject: string; attempts: number }>;
}

export interface RevenueMetrics {
  charges_attempted: Metric;
  charges_succeeded: Metric;
  payment_success_rate: Metric;
  revenue_ghs: Metric;
  new_pro_subs: Metric;
  cancellations: Metric;
  expiries: Metric;
  active_pro_paying: Metric;
  active_pro_entitled: Metric;
  mrr_ghs: Metric;
  pending_churn_ghs: Metric;
  xp_redemptions: Metric;
  xp_credit_days: Metric;
}

export interface AiMetrics {
  spend_usd: Metric;
  spend_mtd_usd: Metric;
  spend_forecast_usd: Metric;
  monthly_cap_usd: Metric;
  by_model: Record<string, number>;
  by_action: Record<string, number>;
  tokens_in: Metric;
  tokens_out: Metric;
  sonnet_share: Metric;
  content_generated: Metric;
  cost_per_generated_item: Metric;
  cost_per_active_pro: Metric;
}

export interface ContentMetrics {
  questions_active: Metric;
  pm_test_active: Metric;
  explanation_coverage_pct: Metric;
  flags_open: Metric;
  flag_rate_per_1k: Metric;
  thin_subjects: Array<{ subject: string; questions: number }>;
}

export interface InfraMetrics {
  db_size_gb: Metric;
  redis_memory_mb: Metric;
  queue_failed: Metric;
  queue_depth_max: Metric;
  queues: Record<string, { waiting: number; failed: number }>;
  backup_ok: boolean | null;
  backup_bytes: Metric;
  disk_used_pct: Metric;
}

export type AlertState = 'ok' | 'warn' | 'critical';

/** Everything persisted in `report_daily_snapshot.metrics`. */
export interface SnapshotMetrics {
  growth: Partial<GrowthMetrics>;
  engagement: Partial<EngagementMetrics>;
  revenue: Partial<RevenueMetrics>;
  ai: Partial<AiMetrics>;
  content: Partial<ContentMetrics>;
  infra: Partial<InfraMetrics>;
  _meta: {
    errors: string[];
    alerts: Record<string, AlertState>;
    /**
     * Metrics a backfilled snapshot could not reconstruct because their
     * source is overwritten in place (queue depth, Redis memory,
     * `users.streak_days`). Renderers dash these with a footnote so a
     * structural gap is never read as a zero.
     */
    non_backfillable: string[];
    backfilled: boolean;
    activated_cohort_date: string;
  };
}
