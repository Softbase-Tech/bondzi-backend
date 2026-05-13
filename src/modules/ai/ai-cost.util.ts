/**
 * AI model cost table (USD per 1M tokens). Single source of truth referenced
 * by the daily-budget guard, per-job hard caps, and the admin cost dashboard.
 *
 * AWS Bedrock pricing in eu-central-1 as of 2026-05. Confirm against the
 * AWS Bedrock pricing page before launch — these change.
 */
export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Bedrock model IDs (anthropic.<name>-v1:0 form). What AwsSdk InvokeModel
  // expects and what AiService receives back from BedrockClient.
  'anthropic.claude-haiku-4-5-20251001-v1:0': {
    inputPerM: 0.25,
    outputPerM: 1.25,
  },
  'anthropic.claude-sonnet-4-5-20250929-v1:0': {
    inputPerM: 3.0,
    outputPerM: 15.0,
  },
};

export function costUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  // Default to Sonnet pricing when we encounter an unknown model — we'd
  // rather over-estimate and under-spend than the inverse.
  const price = PRICING[model] ?? { inputPerM: 3.0, outputPerM: 15.0 };
  return (
    (inputTokens * price.inputPerM + outputTokens * price.outputPerM) /
    1_000_000
  );
}

export function todayUtcDateKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD UTC
}
