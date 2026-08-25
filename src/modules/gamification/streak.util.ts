import { accraDaysBetween } from '../../common/utils/timezone.util';

/**
 * How far back the streak query looks. A streak longer than this is
 * reported as this number — a deliberate trade for a bounded query.
 * At one row per active day, a user who studied every day for a year
 * still returns ~366 rows.
 */
export const STREAK_WINDOW_DAYS = 400;

/**
 * Length of the unbroken run of study days ending today (or yesterday).
 *
 * The single source of truth for "what is this user's streak". Both the
 * displayed number and the persisted `users.streak_days` column are
 * derived from this, over the same set of active days the week dots are
 * drawn from — which is what stops the two from drifting apart.
 *
 * Why yesterday counts: a streak is only broken once a day is actually
 * missed. Someone with a 5-day run who hasn't studied *yet* today still
 * has a 5-day streak; they lose it at tomorrow's midnight, not at this
 * morning's. `getStats` surfaces that difference separately as
 * `streakAtRisk`.
 *
 * @param activeDays Set of `YYYY-MM-DD` Accra dates with >= 1 answer.
 * @param todayIso   Today in Accra, `YYYY-MM-DD`.
 */
export function currentStreakFromActiveDays(
  activeDays: ReadonlySet<string>,
  todayIso: string,
): number {
  if (activeDays.size === 0) return 0;

  // Anchor on today if it's active, else yesterday. Anything older
  // means the run has already been broken.
  let cursor = todayIso;
  if (!activeDays.has(cursor)) {
    cursor = shiftIso(todayIso, -1);
    if (!activeDays.has(cursor)) return 0;
  }

  let streak = 0;
  // Bounded by the query window — a corrupt set can never spin here.
  while (activeDays.has(cursor) && streak < STREAK_WINDOW_DAYS) {
    streak += 1;
    cursor = shiftIso(cursor, -1);
  }
  return streak;
}

/** Shift a `YYYY-MM-DD` by whole days. Accra is UTC+0 year-round. */
function shiftIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Whether a streak of `streakDays` whose last study day is `lastStudy`
 * is currently at risk (studied yesterday, nothing today yet).
 */
export function isStreakAtRisk(
  streakDays: number,
  todayIso: string,
  lastStudy: string | null,
): boolean {
  if (streakDays <= 0 || !lastStudy) return false;
  return accraDaysBetween(todayIso, lastStudy) === 1;
}
