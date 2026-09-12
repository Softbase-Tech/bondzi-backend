/**
 * Registry of Postgres advisory-lock keys used by scheduled jobs.
 *
 * Every cron handler in this directory runs in **both** containers — the
 * API and the worker both import `AppModule`, so both arm every timer. The
 * in-handler `WORKER_MODE` check is the first guard; a
 * `pg_try_advisory_xact_lock(1, <key>)` is the second, and the only one
 * that survives a future multi-worker deployment.
 *
 * Two jobs sharing a key do not fail loudly — they silently skip each
 * other whenever their schedules overlap, and the symptom is "the digest
 * didn't go out last Sunday" weeks later. `weekly-digest` and
 * `daily-reminder` both held 17_003 until this file existed.
 *
 * Keys live here, once, so a collision is a visible duplicate literal in a
 * single list rather than something you find by grepping eight files. The
 * `LOCK_KEYS_ARE_UNIQUE` assertion below turns a duplicate into a failing
 * unit test instead of a silent skip in production.
 *
 * The classid is always `1` (see `tryAcquireAdvisoryXactLock`); only the
 * second parameter varies, so these need to be unique among themselves,
 * not globally unique in the database.
 */
export const LockKey = {
  SUBSCRIPTION_RENEWAL: 17_001,
  STREAK_AT_RISK: 17_002,
  WEEKLY_DIGEST: 17_003,
  WEEKLY_LEADERBOARD_PUSH: 17_004,

  // Automated reporting (§9.3 of the reporting brief).
  REPORT_SNAPSHOT: 17_005,
  REPORT_DAILY: 17_006,
  REPORT_WEEKLY: 17_007,
  REPORT_MONTHLY: 17_008,

  ACCOUNT_DELETION: 17_009,
  ITEM_CALIBRATION: 17_010,
  AI_EVAL: 17_011,
  /** Renumbered out of a collision with WEEKLY_DIGEST (17_003). */
  DAILY_REMINDER: 17_012,
  PAYMENT_ATTEMPT_SWEEP: 17_013,
} as const;

export type LockKeyName = keyof typeof LockKey;

/**
 * Guards the invariant this file exists to protect. Asserted by
 * `advisory-lock-keys.spec.ts`; exported rather than computed inline so
 * the test names the offending keys instead of just failing a count.
 */
export function duplicateLockKeys(): number[] {
  const seen = new Map<number, number>();
  for (const value of Object.values(LockKey)) {
    seen.set(value, (seen.get(value) ?? 0) + 1);
  }
  return [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([value]) => value);
}
