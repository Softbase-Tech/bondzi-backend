/**
 * All period boundaries for PassMaster Ghana are Africa/Accra wall clock.
 * Ghana observes GMT (UTC+00:00) year-round with no DST, so at this moment
 * UTC date math is numerically equivalent — but using these helpers keeps the
 * intent explicit and makes the code correct if the target timezone ever
 * changes (e.g. a regional rollout).
 *
 * Everything returns an ISO date string (YYYY-MM-DD) that Postgres can cast
 * directly into a `date` column.
 */

export const PASSMASTER_TIMEZONE = 'Africa/Accra';

function accraYmd(d: Date = new Date()): {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  weekdayMondayFirst: number; // 0=Mon .. 6=Sun
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PASSMASTER_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(d);

  const year = parseInt(
    parts.find((p) => p.type === 'year')?.value ?? '1970',
    10,
  );
  const month = parseInt(
    parts.find((p) => p.type === 'month')?.value ?? '1',
    10,
  );
  const day = parseInt(parts.find((p) => p.type === 'day')?.value ?? '1', 10);
  const weekdayLabel = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const weekdayMondayFirst =
    { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[
      weekdayLabel as 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun'
    ] ?? 0;

  return { year, month, day, weekdayMondayFirst };
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Today's date in Africa/Accra, formatted `YYYY-MM-DD`. */
export function accraDateIso(d: Date = new Date()): string {
  const { year, month, day } = accraYmd(d);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Monday of the current week in Africa/Accra, formatted `YYYY-MM-DD`. */
export function accraMondayIso(d: Date = new Date()): string {
  const { year, month, day, weekdayMondayFirst } = accraYmd(d);
  // We shift the date by subtracting weekdayMondayFirst days, then rely on
  // the Date constructor to normalise month/year rollover.
  const shifted = new Date(Date.UTC(year, month - 1, day - weekdayMondayFirst));
  return shifted.toISOString().slice(0, 10);
}

/** First-of-month in Africa/Accra, formatted `YYYY-MM-DD`. */
export function accraMonthStartIso(d: Date = new Date()): string {
  const { year, month } = accraYmd(d);
  return `${year}-${pad(month)}-01`;
}

/**
 * Count of whole days between two `YYYY-MM-DD` strings, treated as Accra
 * wall clock. Positive when `later` > `earlier`, zero when equal.
 */
export function accraDaysBetween(laterIso: string, earlierIso: string): number {
  const l = Date.parse(`${laterIso}T00:00:00Z`);
  const e = Date.parse(`${earlierIso}T00:00:00Z`);
  return Math.round((l - e) / (24 * 60 * 60 * 1000));
}
