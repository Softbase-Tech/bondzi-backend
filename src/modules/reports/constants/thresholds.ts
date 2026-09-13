import type { AlertState, Metric } from '../collectors/collector.types';

/**
 * Alert thresholds, in one file so tuning them is a one-file change
 * rather than a hunt through six collectors.
 *
 * **Volume floors are the important part.** A percentage is noise at beta
 * volumes: a payment success rate of 50% on two attempts means nothing,
 * and an alert that cries wolf at n=2 is an alert nobody reads by month
 * three. A ratio is only *evaluated* when its denominator meets the floor;
 * below it the metric still renders, tagged with its `n`, and always
 * counts as `ok`.
 *
 * `direction` says which way is bad, so one comparator handles both
 * "success rate fell" and "latency rose" without each call site
 * re-deciding.
 */
export interface Threshold {
  warn: number;
  critical: number;
  /** 'below' = smaller is worse (rates); 'above' = larger is worse (cost). */
  direction: 'below' | 'above';
  /** Minimum denominator before the threshold is evaluated at all. */
  floor?: number;
}

export const THRESHOLDS = {
  payment_success_rate: {
    warn: 0.9,
    critical: 0.75,
    direction: 'below',
    floor: 10,
  },
  activation_rate: { warn: 0.45, critical: 0.3, direction: 'below', floor: 10 },
  signups_vs_trailing: {
    warn: -0.4,
    critical: -0.7,
    direction: 'below',
    floor: 10,
  },
  ai_spend_day_usd: { warn: 3, critical: 10, direction: 'above' },
  /** Forecast as a fraction of the monthly cap. */
  ai_forecast_vs_cap: {
    warn: 0.85,
    critical: 1.0,
    direction: 'above',
    floor: 3,
  },
  sonnet_share: { warn: 0.25, critical: 0.5, direction: 'above' },
  queue_failed: { warn: 1, critical: 20, direction: 'above' },
  queue_depth: { warn: 500, critical: 5000, direction: 'above' },
  db_size_gb: { warn: 6, critical: 7.5, direction: 'above' },
  /** Prod Redis runs maxmemory 128mb with noeviction — at the cap BullMQ
   *  writes fail outright, so this is a queue-outage warning, not
   *  housekeeping. */
  redis_memory_mb: { warn: 100, critical: 120, direction: 'above' },
  disk_used_pct: { warn: 75, critical: 85, direction: 'above' },
  flag_rate_per_1k: { warn: 5, critical: 15, direction: 'above', floor: 1000 },
} as const satisfies Record<string, Threshold>;

export type ThresholdKey = keyof typeof THRESHOLDS;

/**
 * Evaluate one metric against its threshold.
 *
 * Returns `ok` for a null metric: "we could not measure it" is not the
 * same as "it is bad", and raising a critical alert because a collector
 * timed out trains the reader to ignore the status line.
 *
 * `denominator` is required for any threshold carrying a floor; passing
 * one below the floor forces `ok`.
 */
export function evaluate(
  key: ThresholdKey,
  value: Metric,
  denominator?: number,
): AlertState {
  if (value === null || !Number.isFinite(value)) return 'ok';
  const t: Threshold = THRESHOLDS[key];
  if (t.floor !== undefined) {
    if (denominator === undefined || denominator < t.floor) return 'ok';
  }
  const worse = (limit: number) =>
    t.direction === 'below' ? value < limit : value > limit;
  if (worse(t.critical)) return 'critical';
  if (worse(t.warn)) return 'warn';
  return 'ok';
}

/** The worst state present. Drives the subject-line status token. */
export function worstState(states: AlertState[]): AlertState {
  if (states.includes('critical')) return 'critical';
  if (states.includes('warn')) return 'warn';
  return 'ok';
}

/**
 * Safe division. Every ratio in every collector goes through this.
 *
 * Returns null — never NaN, never Infinity, never 0 — when the
 * denominator is zero or either side is unusable. A NaN reaching the
 * snapshot would be stored as the JSON string "null" or crash a cast;
 * an Infinity would render as "∞%" in an email.
 */
export function ratio(numerator: Metric, denominator: Metric): Metric {
  if (numerator === null || denominator === null) return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator === 0) return null;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : null;
}
