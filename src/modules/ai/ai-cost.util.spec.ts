import { costUsd, todayUtcDateKey } from './ai-cost.util';

describe('costUsd', () => {
  it('computes Claude Sonnet 4.6 cost correctly', () => {
    // 1000 input tokens * $3/M = $0.003; 500 output * $15/M = $0.0075; total $0.0105
    expect(costUsd('claude-sonnet-4-6', 1000, 500)).toBeCloseTo(0.0105, 6);
  });

  it('computes Haiku 4.5 cost correctly', () => {
    // 2000 input * $0.25/M = $0.0005; 1000 output * $1.25/M = $0.00125
    expect(costUsd('claude-haiku-4-5', 2000, 1000)).toBeCloseTo(0.00175, 6);
  });

  it('falls back to a default for unknown models (non-zero)', () => {
    const cost = costUsd('unknown-model', 1000, 1000);
    expect(cost).toBeGreaterThan(0);
  });
});

describe('todayUtcDateKey', () => {
  it('returns YYYY-MM-DD', () => {
    const key = todayUtcDateKey(new Date('2026-04-16T03:00:00Z'));
    expect(key).toBe('2026-04-16');
  });

  it('is UTC, not local', () => {
    const late = new Date('2026-04-16T23:59:59Z');
    expect(todayUtcDateKey(late)).toBe('2026-04-16');
  });
});
