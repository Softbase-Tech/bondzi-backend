/**
 * How each metric combines across days.
 *
 * This table is the whole reason the aggregator exists. "Show me the
 * week" is not one operation — it is four, and applying the wrong one
 * produces a number that looks entirely plausible:
 *
 *   • `sum`      — flow quantities. Signups, revenue, attempts, AI spend.
 *                  Add the days.
 *   • `latest`   — stock quantities. MRR, active Pro, database size. These
 *                  describe a moment, not an interval. **Summing MRR over
 *                  30 days reports 30x the real figure** — the same class
 *                  of error as the admin tile that counted an annual
 *                  subscription at 12x.
 *   • `ratio`    — recomputed from the summed numerator over the summed
 *                  denominator, never by averaging the daily rates.
 *                  Averaging weights a day with 2 payment attempts exactly
 *                  as heavily as a day with 200.
 *   • `active`   — distinct-user counts. These can be neither summed (the
 *                  same student active on Monday and Tuesday would count
 *                  twice) nor averaged. The collector already stores the
 *                  correct distinct count for each window, so the period
 *                  selects the right field: day→dau, week→wau, month→mau.
 *   • `series`   — quantities that genuinely cannot be combined. A median
 *                  of medians is not a median. Shown as a daily series
 *                  instead of a fabricated single figure.
 */
export type MetricKind = 'sum' | 'latest' | 'ratio' | 'active' | 'series';

export interface MetricRule {
  kind: MetricKind;
  /** `ratio` only: dotted paths of the parts to recompute from. */
  numerator?: string;
  denominator?: string;
  /** `ratio` only: multiplier, e.g. 1000 for "per 1,000". */
  scale?: number;
}

/**
 * Keyed by dotted path into the snapshot's `metrics` object.
 * A metric absent from this table is carried through as `latest`, which
 * is the conservative default: it may be stale, but it is never a
 * fabricated total.
 */
export const METRIC_RULES: Record<string, MetricRule> = {
  // ---- growth -------------------------------------------------------
  'growth.signups': { kind: 'sum' },
  'growth.activated': { kind: 'sum' },
  'growth.activated_cohort_size': { kind: 'sum' },
  'growth.activation_rate': {
    kind: 'ratio',
    numerator: 'growth.activated',
    denominator: 'growth.activated_cohort_size',
  },
  'growth.partner_attributed': { kind: 'sum' },
  'growth.referral_attributed': { kind: 'sum' },
  'growth.referrals_created': { kind: 'sum' },
  'growth.referrals_qualified': { kind: 'sum' },
  // Catalogue-wide data quality: a property of the table right now, not
  // something that accumulates over a week.
  'growth.school_null_rate': { kind: 'latest' },
  'growth.school_distinct': { kind: 'latest' },

  // ---- engagement ---------------------------------------------------
  'engagement.dau': { kind: 'active' },
  'engagement.wau': { kind: 'latest' },
  'engagement.mau': { kind: 'latest' },
  'engagement.dau_mau_ratio': {
    kind: 'ratio',
    numerator: 'engagement.dau',
    denominator: 'engagement.mau',
  },
  'engagement.practice_sessions': { kind: 'sum' },
  'engagement.sessions_completed': { kind: 'sum' },
  'engagement.sessions_completed_pct': {
    kind: 'ratio',
    numerator: 'engagement.sessions_completed',
    denominator: 'engagement.practice_sessions',
  },
  'engagement.questions_attempted': { kind: 'sum' },
  // A median cannot be recovered from daily medians.
  'engagement.median_accuracy': { kind: 'series' },
  'engagement.mock_exams_taken': { kind: 'sum' },
  'engagement.quiz_sessions': { kind: 'sum' },
  'engagement.explanations_viewed': { kind: 'sum' },
  'engagement.explanation_requests': { kind: 'sum' },
  // Overwritten in place on the users table — a point-in-time headcount.
  'engagement.streaks_active': { kind: 'latest' },

  // ---- revenue ------------------------------------------------------
  'revenue.charges_attempted': { kind: 'sum' },
  'revenue.charges_succeeded': { kind: 'sum' },
  'revenue.payment_success_rate': {
    kind: 'ratio',
    numerator: 'revenue.charges_succeeded',
    denominator: 'revenue.charges_attempted',
  },
  'revenue.revenue_ghs': { kind: 'sum' },
  'revenue.new_pro_subs': { kind: 'sum' },
  'revenue.cancellations': { kind: 'sum' },
  'revenue.expiries': { kind: 'sum' },
  'revenue.xp_redemptions': { kind: 'sum' },
  'revenue.xp_credit_days': { kind: 'sum' },
  // Stock, not flow. Summing these is the 30x bug.
  'revenue.active_pro_paying': { kind: 'latest' },
  'revenue.active_pro_entitled': { kind: 'latest' },
  'revenue.mrr_ghs': { kind: 'latest' },
  'revenue.pending_churn_ghs': { kind: 'latest' },

  // ---- ai -----------------------------------------------------------
  'ai.spend_usd': { kind: 'sum' },
  'ai.tokens_in': { kind: 'sum' },
  'ai.tokens_out': { kind: 'sum' },
  'ai.content_generated': { kind: 'sum' },
  // Already a month-to-date running total; adding the days would square it.
  'ai.spend_mtd_usd': { kind: 'latest' },
  'ai.spend_forecast_usd': { kind: 'latest' },
  'ai.monthly_cap_usd': { kind: 'latest' },
  'ai.cost_per_generated_item': {
    kind: 'ratio',
    numerator: 'ai.spend_usd',
    denominator: 'ai.content_generated',
  },
  'ai.cost_per_active_pro': {
    kind: 'ratio',
    numerator: 'ai.spend_usd',
    denominator: 'revenue.active_pro_entitled',
  },
  // Share of spend: recomputed from the model breakdown, handled separately.
  'ai.sonnet_share': { kind: 'series' },

  // ---- content ------------------------------------------------------
  'content.questions_active': { kind: 'latest' },
  'content.pm_test_active': { kind: 'latest' },
  'content.explanation_coverage_pct': { kind: 'latest' },
  'content.flags_open': { kind: 'latest' },
  'content.flag_rate_per_1k': { kind: 'series' },

  // ---- infra (all point-in-time) ------------------------------------
  'infra.db_size_gb': { kind: 'latest' },
  'infra.redis_memory_mb': { kind: 'latest' },
  'infra.queue_failed': { kind: 'latest' },
  'infra.queue_depth_max': { kind: 'latest' },
  'infra.disk_used_pct': { kind: 'latest' },
  'infra.backup_bytes': { kind: 'latest' },
};

/** Metrics rendered as a daily series because no single value is honest. */
export const SERIES_ONLY = Object.entries(METRIC_RULES)
  .filter(([, r]) => r.kind === 'series')
  .map(([k]) => k);

/** Which field holds the distinct-user count for a given period. */
export const ACTIVE_FIELD_FOR = {
  day: 'engagement.dau',
  week: 'engagement.wau',
  month: 'engagement.mau',
} as const;

export type Period = keyof typeof ACTIVE_FIELD_FOR;
