import {
  accraDateIso,
  accraDaysBetween,
  accraMondayIso,
  accraMonthStartIso,
} from './timezone.util';

describe('timezone utilities (Africa/Accra)', () => {
  describe('accraDateIso', () => {
    it('formats a known UTC instant as its Accra date', () => {
      // Ghana is UTC+0, so the wall-clock date at this instant is the
      // same as the UTC date.
      expect(accraDateIso(new Date('2026-04-24T12:34:56Z'))).toBe('2026-04-24');
    });

    it('handles the UTC midnight boundary', () => {
      expect(accraDateIso(new Date('2026-04-24T00:00:00Z'))).toBe('2026-04-24');
      expect(accraDateIso(new Date('2026-04-23T23:59:59Z'))).toBe('2026-04-23');
    });
  });

  describe('accraMondayIso', () => {
    it('returns Monday for a Wednesday', () => {
      // 2026-04-22 is a Wednesday -> Monday is 2026-04-20
      expect(accraMondayIso(new Date('2026-04-22T10:00:00Z'))).toBe(
        '2026-04-20',
      );
    });

    it('returns the same day for a Monday', () => {
      expect(accraMondayIso(new Date('2026-04-20T10:00:00Z'))).toBe(
        '2026-04-20',
      );
    });

    it('returns last Monday for a Sunday', () => {
      expect(accraMondayIso(new Date('2026-04-26T10:00:00Z'))).toBe(
        '2026-04-20',
      );
    });

    it('crosses a month boundary cleanly', () => {
      // 2026-05-01 is a Friday -> Monday is 2026-04-27
      expect(accraMondayIso(new Date('2026-05-01T12:00:00Z'))).toBe(
        '2026-04-27',
      );
    });
  });

  describe('accraMonthStartIso', () => {
    it('returns first-of-month', () => {
      expect(accraMonthStartIso(new Date('2026-04-24T12:00:00Z'))).toBe(
        '2026-04-01',
      );
    });
  });

  describe('accraDaysBetween', () => {
    it('is 1 for consecutive days', () => {
      expect(accraDaysBetween('2026-04-24', '2026-04-23')).toBe(1);
    });
    it('is 0 for the same day', () => {
      expect(accraDaysBetween('2026-04-24', '2026-04-24')).toBe(0);
    });
    it('is 7 across a week', () => {
      expect(accraDaysBetween('2026-04-30', '2026-04-23')).toBe(7);
    });
  });
});
