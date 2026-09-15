import {
  activationCohortFor,
  periodRangeFor,
  dayBounds,
  daysInclusive,
  eachDay,
  rangeBounds,
  resolveRange,
  shiftIso,
  snapshotDateFor,
  utcDateIso,
} from './date-range.util';

/**
 * Period boundaries are the one thing in the reporting module that is
 * both pure and catastrophic when wrong: an off-by-one week silently
 * reports Sunday-to-Saturday and every week-over-week comparison shifts
 * by a day forever, with no error to notice.
 */
describe('report date ranges', () => {
  describe('daily', () => {
    it('covers yesterday, not today', () => {
      const now = new Date('2026-09-11T06:00:00.000Z');
      expect(resolveRange('daily', now)).toEqual({
        start: '2026-09-10',
        end: '2026-09-10',
      });
    });

    it('rolls back across a month boundary', () => {
      expect(snapshotDateFor(new Date('2026-09-01T00:15:00.000Z'))).toBe(
        '2026-08-31',
      );
    });

    it('rolls back across a year boundary', () => {
      expect(snapshotDateFor(new Date('2026-01-01T00:15:00.000Z'))).toBe(
        '2025-12-31',
      );
    });
  });

  describe('weekly', () => {
    // The job runs Monday 06:15. The period must be the *previous*
    // Mon..Sun, never the week in progress.
    it('on a Monday, covers the week that just ended', () => {
      const monday = new Date('2026-09-07T06:15:00.000Z'); // a Monday
      expect(new Date('2026-09-07T00:00:00Z').getUTCDay()).toBe(1);
      expect(resolveRange('weekly', monday)).toEqual({
        start: '2026-08-31',
        end: '2026-09-06',
      });
    });

    it('on a Sunday, still looks back a full week — the (dow+6)%7 case', () => {
      const sunday = new Date('2026-09-13T06:15:00.000Z');
      expect(sunday.getUTCDay()).toBe(0);
      const r = resolveRange('weekly', sunday);
      // Sunday belongs to the week starting Mon 7 Sep, so the previous
      // week is 31 Aug..6 Sep. A naive `-dow` would have produced a
      // Sunday-start week here.
      expect(r).toEqual({ start: '2026-08-31', end: '2026-09-06' });
      expect(new Date(`${r.start}T00:00:00Z`).getUTCDay()).toBe(1);
      expect(new Date(`${r.end}T00:00:00Z`).getUTCDay()).toBe(0);
    });

    it('always spans exactly 7 days, Monday to Sunday, on every weekday', () => {
      for (let i = 0; i < 14; i++) {
        const now = new Date(Date.UTC(2026, 8, 1 + i, 6, 15));
        const r = resolveRange('weekly', now);
        expect(daysInclusive(r.start, r.end)).toBe(7);
        expect(new Date(`${r.start}T00:00:00Z`).getUTCDay()).toBe(1);
        expect(new Date(`${r.end}T00:00:00Z`).getUTCDay()).toBe(0);
      }
    });
  });

  describe('monthly', () => {
    it('covers the previous calendar month', () => {
      expect(
        resolveRange('monthly', new Date('2026-09-01T06:30:00.000Z')),
      ).toEqual({ start: '2026-08-01', end: '2026-08-31' });
    });

    it('handles the 30-day month before it', () => {
      expect(
        resolveRange('monthly', new Date('2026-07-01T06:30:00.000Z')),
      ).toEqual({ start: '2026-06-01', end: '2026-06-30' });
    });

    it('handles January → previous December', () => {
      expect(
        resolveRange('monthly', new Date('2026-01-01T06:30:00.000Z')),
      ).toEqual({ start: '2025-12-01', end: '2025-12-31' });
    });

    it('handles a leap February', () => {
      expect(
        resolveRange('monthly', new Date('2024-03-01T06:30:00.000Z')),
      ).toEqual({ start: '2024-02-01', end: '2024-02-29' });
    });
  });

  describe('day bounds', () => {
    it('are half-open so midnight belongs to exactly one day', () => {
      const { from, to } = dayBounds('2026-09-10');
      expect(from.toISOString()).toBe('2026-09-10T00:00:00.000Z');
      expect(to.toISOString()).toBe('2026-09-11T00:00:00.000Z');
      // The upper bound is the NEXT day's midnight and is excluded, so an
      // event at exactly 00:00:00.000 on the 11th is not counted twice.
      expect(dayBounds('2026-09-11').from.getTime()).toBe(to.getTime());
    });

    it('span a whole inclusive range', () => {
      const { from, to } = rangeBounds({
        start: '2026-09-01',
        end: '2026-09-03',
      });
      expect(from.toISOString()).toBe('2026-09-01T00:00:00.000Z');
      expect(to.toISOString()).toBe('2026-09-04T00:00:00.000Z');
    });
  });

  describe('activation cohort', () => {
    it('lags the snapshot by one day so the 24h window is closed', () => {
      expect(activationCohortFor('2026-09-10')).toBe('2026-09-09');
    });
  });

  describe('helpers', () => {
    it('shiftIso crosses month and year ends', () => {
      expect(shiftIso('2026-08-31', 1)).toBe('2026-09-01');
      expect(shiftIso('2026-01-01', -1)).toBe('2025-12-31');
      expect(shiftIso('2024-02-28', 1)).toBe('2024-02-29');
    });

    it('daysInclusive counts both ends', () => {
      expect(daysInclusive('2026-09-01', '2026-09-01')).toBe(1);
      expect(daysInclusive('2026-09-01', '2026-09-07')).toBe(7);
    });

    it('eachDay enumerates ascending and inclusive', () => {
      expect(eachDay({ start: '2026-08-30', end: '2026-09-02' })).toEqual([
        '2026-08-30',
        '2026-08-31',
        '2026-09-01',
        '2026-09-02',
      ]);
    });

    it('utcDateIso ignores local time entirely', () => {
      expect(utcDateIso(new Date('2026-09-10T23:59:59.999Z'))).toBe(
        '2026-09-10',
      );
    });
  });
});

describe('periodRangeFor (viewer-anchored, includes the anchor)', () => {
  it('day is the anchor itself', () => {
    expect(periodRangeFor('day', '2026-09-10')).toEqual({
      start: '2026-09-10',
      end: '2026-09-10',
    });
  });

  it('week is the Monday-start week CONTAINING the anchor', () => {
    // Unlike resolveRange, which returns the previous completed week: an
    // operator asking for "this week" means the one they are in.
    expect(periodRangeFor('week', '2026-09-10')).toEqual({
      start: '2026-09-07',
      end: '2026-09-13',
    });
  });

  it('a Sunday anchor belongs to the week that started on Monday', () => {
    const r = periodRangeFor('week', '2026-09-13');
    expect(r).toEqual({ start: '2026-09-07', end: '2026-09-13' });
    expect(new Date(`${r.start}T00:00:00Z`).getUTCDay()).toBe(1);
  });

  it('month spans the whole calendar month containing the anchor', () => {
    expect(periodRangeFor('month', '2026-09-10')).toEqual({
      start: '2026-09-01',
      end: '2026-09-30',
    });
  });

  it('gets month lengths right, including a leap February', () => {
    expect(periodRangeFor('month', '2024-02-15').end).toBe('2024-02-29');
    expect(periodRangeFor('month', '2026-02-15').end).toBe('2026-02-28');
    expect(periodRangeFor('month', '2026-12-31').end).toBe('2026-12-31');
  });
});
