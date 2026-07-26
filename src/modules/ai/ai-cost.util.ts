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

/**
 * Highest-known input + output per-million across the table. Used as
 * the default when an unknown model ID comes through — over-estimate
 * cost so the daily budget guard never under-counts what we owe AWS.
 * Recomputed at module load (when PRICING is frozen) so new entries
 * automatically participate.
 */
const FALLBACK_PRICING: ModelPricing = Object.values(PRICING).reduce(
  (max, p) => ({
    inputPerM: Math.max(max.inputPerM, p.inputPerM),
    outputPerM: Math.max(max.outputPerM, p.outputPerM),
  }),
  { inputPerM: 0, outputPerM: 0 },
);

export function costUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  // Local / self-hosted generations (Ollama) bill $0 — the pricing
  // table is Bedrock-only. Without this short-circuit, `ollama:<name>`
  // would fall through to FALLBACK_PRICING and inflate the daily
  // budget counter against imaginary AWS spend.
  if (model.startsWith('ollama:')) return 0;
  // Cross-region inference profiles prefix the Bedrock model ID with a
  // geo (`eu.anthropic.claude-...`, `us.anthropic.claude-...`). Strip it
  // so pricing resolves identically whether we're handed a raw model ID
  // or an inference-profile ID.
  const normalized = model.replace(/^(us|eu|apac|us-gov)\./, '');
  // Unknown model -> bill against the most expensive known model. A
  // hardcoded "Sonnet rate" silently bills any future Opus / Claude 5
  // job at Sonnet rates and underflows the daily budget. Computing
  // max dynamically removes that footgun.
  const price = PRICING[normalized] ?? PRICING[model] ?? FALLBACK_PRICING;
  return (
    (inputTokens * price.inputPerM + outputTokens * price.outputPerM) /
    1_000_000
  );
}

export function todayUtcDateKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD UTC
}
