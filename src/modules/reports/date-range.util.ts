import type { ReportType } from './entities/report-delivery.entity';

/** Inclusive calendar range, both ends `YYYY-MM-DD` in UTC. */
export interface DateRange {
  start: string;
  end: string;
}

/**
 * All reporting periods are UTC calendar periods.
 *
 * Ghana is UTC+0 year-round with no DST, so UTC and Africa/Accra wall
 * clock are the same date — which means these line up with the two column
 * families that store Accra dates (`user_service_usage.day`,
 * `users.last_study_date`) without conversion. Everything here is pure and
 * takes `now` as an argument so the boundaries are testable without
 * freezing the clock.
 */

/** `YYYY-MM-DD` for the UTC calendar day containing `d`. */
export function utcDateIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Shift a `YYYY-MM-DD` by whole days, staying in UTC. */
export function shiftIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return utcDateIso(d);
}

/** Inclusive day count between two ISO dates. `a..a` is 1. */
export function daysInclusive(startIso: string, endIso: string): number {
  const a = Date.parse(`${startIso}T00:00:00.000Z`);
  const b = Date.parse(`${endIso}T00:00:00.000Z`);
  return Math.floor((b - a) / 86_400_000) + 1;
}

/** Every date in an inclusive range, ascending. */
export function eachDay(range: DateRange): string[] {
  const out: string[] = [];
  for (let d = range.start; d <= range.end; d = shiftIso(d, 1)) out.push(d);
  return out;
}

/**
 * Half-open `[start, end)` timestamps for a whole UTC day.
 *
 * Half-open, not `BETWEEN`: a `timestamptz` at exactly 00:00:00.000 on the
 * following day belongs to that day, and an inclusive upper bound would
 * double-count it into both. Every collector uses this rather than
 * `::date =` where an index on the timestamp column exists, because
 * `created_at >= $1 AND created_at < $2` is sargable and `created_at::date
 * = $1` is not.
 */
export function dayBounds(iso: string): { from: Date; to: Date } {
  return {
    from: new Date(`${iso}T00:00:00.000Z`),
    to: new Date(`${shiftIso(iso, 1)}T00:00:00.000Z`),
  };
}

/** Half-open bounds spanning an inclusive date range. */
export function rangeBounds(range: DateRange): { from: Date; to: Date } {
  return {
    from: dayBounds(range.start).from,
    to: dayBounds(range.end).to,
  };
}

/** The day a snapshot taken at `now` should cover: yesterday, UTC. */
export function snapshotDateFor(now: Date): string {
  return shiftIso(utcDateIso(now), -1);
}

/**
 * The activation cohort a snapshot for `snapshotDate` reports on.
 *
 * One day behind the snapshot, and the reason matters: activation is
 * "signed up and completed a session within 24h". A user who registers at
 * 23:00 on day D still has 23 hours of that window open when the 00:15
 * job for D fires. Snapshots are immutable, so computing activation for D
 * would bake in an undercount that is never revisited. Reporting the
 * cohort of D−1 — whose window is fully closed — is correct instead of
 * merely fresher, and renderers label the line with this date so the
 * reader is never guessing which cohort a rate refers to.
 */
export function activationCohortFor(snapshotDate: string): string {
  return shiftIso(snapshotDate, -1);
}

/**
 * The period a report run at `now` covers.
 *
 *   daily   — yesterday
 *   weekly  — the previous ISO week (Monday..Sunday)
 *   monthly — the previous calendar month
 *
 * Always a *completed* period: a report about a period still in progress
 * invites comparing a part-day against a whole one.
 */
export function resolveRange(type: ReportType, now: Date): DateRange {
  if (type === 'daily') {
    const d = snapshotDateFor(now);
    return { start: d, end: d };
  }

  if (type === 'weekly') {
    // getUTCDay(): 0=Sunday..6=Saturday. Monday is the ISO week start, so
    // Sunday must look back 6 days, not 0 — the classic off-by-one that
    // silently produces a Sunday-to-Saturday "week".
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const dow = today.getUTCDay();
    const daysSinceMonday = (dow + 6) % 7;
    const thisMonday = utcDateIso(today);
    const lastMonday = shiftIso(thisMonday, -daysSinceMonday - 7);
    return { start: lastMonday, end: shiftIso(lastMonday, 6) };
  }

  // monthly — first..last day of the previous calendar month.
  const firstOfThis = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const lastOfPrev = new Date(firstOfThis - 86_400_000);
  const y = lastOfPrev.getUTCFullYear();
  const m = lastOfPrev.getUTCMonth();
  return {
    start: utcDateIso(new Date(Date.UTC(y, m, 1))),
    end: utcDateIso(lastOfPrev),
  };
}
