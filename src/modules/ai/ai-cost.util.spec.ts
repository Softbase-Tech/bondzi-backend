import { costUsd, todayUtcDateKey } from './ai-cost.util';

// Bedrock model IDs — must match the keys in PRICING. Centralising here so
// a renamed model only needs to be touched once in this file.
const SONNET = 'anthropic.claude-sonnet-4-5-20250929-v1:0';
const HAIKU = 'anthropic.claude-haiku-4-5-20251001-v1:0';

describe('costUsd', () => {
  it('computes Bedrock Sonnet cost correctly', () => {
    // 1000 input tokens * $3/M = $0.003; 500 output * $15/M = $0.0075; total $0.0105
    expect(costUsd(SONNET, 1000, 500)).toBeCloseTo(0.0105, 6);
  });

  it('computes Bedrock Haiku cost correctly', () => {
    // 2000 input * $1.00/M = $0.002; 1000 output * $5.00/M = $0.005; total $0.007
    expect(costUsd(HAIKU, 2000, 1000)).toBeCloseTo(0.007, 6);
  });

  it('prices cross-region inference profile IDs like the bare model ID', () => {
    // Bedrock on-demand invocation uses geo-prefixed inference profile IDs
    // (e.g. `eu.anthropic.claude-...`). Pricing must resolve to the same
    // entry, not fall through to the (more expensive) unknown-model default.
    expect(
      costUsd('eu.anthropic.claude-haiku-4-5-20251001-v1:0', 2000, 1000),
    ).toBeCloseTo(costUsd(HAIKU, 2000, 1000), 6);
    expect(
      costUsd('us.anthropic.claude-sonnet-4-5-20250929-v1:0', 1000, 500),
    ).toBeCloseTo(costUsd(SONNET, 1000, 500), 6);
  });

  it('falls back to a default for unknown models (non-zero)', () => {
    // The fallback intentionally over-estimates by using Sonnet pricing —
    // we'd rather flag a cost guard early than miss a runaway model.
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
