import { sm2 } from './sm2.util';

describe('sm2', () => {
  const fixedNow = new Date('2026-01-01T00:00:00Z');

  it('throws on out-of-range quality', () => {
    expect(() =>
      sm2(-1, { easeFactor: 2.5, intervalDays: 1, repetitions: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      sm2(6, { easeFactor: 2.5, intervalDays: 1, repetitions: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      sm2(3.5 as unknown as number, {
        easeFactor: 2.5,
        intervalDays: 1,
        repetitions: 0,
      }),
    ).toThrow(RangeError);
  });

  it('resets on quality < 3', () => {
    const out = sm2(
      2,
      { easeFactor: 2.5, intervalDays: 10, repetitions: 5 },
      fixedNow,
    );
    expect(out.repetitions).toBe(0);
    expect(out.intervalDays).toBe(1);
    expect(out.nextReviewAt.getTime()).toBe(fixedNow.getTime() + 86400000);
  });

  it('first-repetition interval is 1', () => {
    const out = sm2(
      5,
      { easeFactor: 2.5, intervalDays: 1, repetitions: 0 },
      fixedNow,
    );
    expect(out.intervalDays).toBe(1);
    expect(out.repetitions).toBe(1);
  });

  it('second-repetition interval is 6', () => {
    const out = sm2(
      4,
      { easeFactor: 2.5, intervalDays: 1, repetitions: 1 },
      fixedNow,
    );
    expect(out.intervalDays).toBe(6);
    expect(out.repetitions).toBe(2);
  });

  it('subsequent interval is round(interval * ef)', () => {
    const out = sm2(
      4,
      { easeFactor: 2.5, intervalDays: 6, repetitions: 2 },
      fixedNow,
    );
    // ef = max(1.3, 2.5 + 0.1 - 1*(0.08+0.02)) = 2.5
    expect(out.easeFactor).toBeCloseTo(2.5, 5);
    expect(out.intervalDays).toBe(15);
  });

  it('clamps ease factor to 1.3 minimum', () => {
    // drive it low: several quality=3 updates where delta is negative
    let state = { easeFactor: 1.5, intervalDays: 6, repetitions: 2 };
    for (let i = 0; i < 10; i++) {
      state = sm2(3, state, fixedNow);
    }
    expect(state.easeFactor).toBeGreaterThanOrEqual(1.3);
  });

  it('increments repetitions exactly once on quality >= 3', () => {
    const out = sm2(
      5,
      { easeFactor: 2.5, intervalDays: 6, repetitions: 7 },
      fixedNow,
    );
    expect(out.repetitions).toBe(8);
  });

  it('nextReviewAt is intervalDays*86_400_000 after now', () => {
    const out = sm2(
      5,
      { easeFactor: 2.5, intervalDays: 6, repetitions: 2 },
      fixedNow,
    );
    expect(out.nextReviewAt.getTime() - fixedNow.getTime()).toBe(
      out.intervalDays * 86400000,
    );
  });
});
