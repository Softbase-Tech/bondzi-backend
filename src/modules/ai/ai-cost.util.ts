/**
 * AI model cost table (USD per 1M tokens). Update when Anthropic/OpenAI change
 * pricing — this file is the single source of truth referenced by cost guards
 * and the admin dashboard.
 *
 * Costs are conservative — we prefer to over-estimate and under-bill ourselves
 * than under-estimate and blow the daily budget.
 */
export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Anthropic Claude — 2025 pricing as of v1.0 of the spec.
  'claude-sonnet-4-6': { inputPerM: 3.0, outputPerM: 15.0 },
  'claude-haiku-4-5': { inputPerM: 0.25, outputPerM: 1.25 },
  'claude-haiku-4-5-20251001': { inputPerM: 0.25, outputPerM: 1.25 },
  'claude-opus-4-6': { inputPerM: 15.0, outputPerM: 75.0 },
  // OpenAI failover.
  'gpt-4o': { inputPerM: 2.5, outputPerM: 10.0 },
  'gpt-4o-mini': { inputPerM: 0.15, outputPerM: 0.6 },
  'gpt-4.1': { inputPerM: 2.0, outputPerM: 8.0 },
};

export function costUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = PRICING[model] ?? { inputPerM: 2, outputPerM: 8 };
  return (
    (inputTokens * price.inputPerM + outputTokens * price.outputPerM) /
    1_000_000
  );
}

export function todayUtcDateKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD UTC
}
