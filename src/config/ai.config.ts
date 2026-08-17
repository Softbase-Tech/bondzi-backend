import { registerAs } from '@nestjs/config';

/**
 * AI configuration. Provider is now AWS Bedrock — auth lands through the
 * standard AWS SDK chain (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY or an
 * IAM role on the instance), so there are no Anthropic / OpenAI keys to
 * configure here any more.
 *
 * Spec §9.3 env vars (in Bedrock form). Model IDs are cross-region
 * inference profile IDs (geo-prefixed) — Bedrock rejects the bare
 * `anthropic.*` model ID for on-demand invocation of these models. The
 * `eu.` prefix matches AWS_REGION=eu-central-1; use `us.` for us-* regions.
 *   AI_DEFAULT_MODEL=eu.anthropic.claude-haiku-4-5-20251001-v1:0   # fast/cheap
 *   AI_QUALITY_MODEL=eu.anthropic.claude-sonnet-4-5-20250929-v1:0  # higher quality
 *   AI_MAX_JOB_COST_USD=500                                        # per-job hard cap
 *   AI_BEDROCK_MAX_RETRIES=3                                       # SDK retry count
 *   AWS_REGION=eu-central-1                                        # Bedrock region
 *
 * Legacy names AI_FAST_MODEL / AI_EXPLANATION_MODEL are kept as fallbacks so
 * older env files keep working; prefer the spec-canonical names going forward.
 */
export default registerAs('ai', () => ({
  explanationModel:
    process.env.AI_QUALITY_MODEL ??
    process.env.AI_EXPLANATION_MODEL ??
    'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
  fastModel:
    process.env.AI_DEFAULT_MODEL ??
    process.env.AI_FAST_MODEL ??
    'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
  dailyBudgetUsd: parseFloat(process.env.AI_DAILY_BUDGET_USD ?? '50'),
  perUserDailyLimit: parseInt(process.env.AI_PER_USER_DAILY_LIMIT ?? '50', 10),
  maxJobCostUsd: parseFloat(process.env.AI_MAX_JOB_COST_USD ?? '500'),
  // Jobs over this estimated cost wait in PENDING_APPROVAL for a second
  // admin's sign-off. 0 disables the gate entirely.
  cosignThresholdUsd: parseFloat(process.env.AI_COSIGN_THRESHOLD_USD ?? '50'),
  bedrockMaxRetries: parseInt(process.env.AI_BEDROCK_MAX_RETRIES ?? '3', 10),
  // Client-side requests-per-minute ceiling for Bedrock. Bedrock enforces an
  // account-level RPM quota per model; the worker paces bulk calls to stay
  // under this. Set it to your *granted* RPM (see AWS Service Quotas), with
  // headroom. Read directly from env in BedrockClient; mirrored here for docs.
  bedrockMaxRpm: parseInt(process.env.AI_BEDROCK_MAX_RPM ?? '10', 10),
  /**
   * Hard ceiling on items per admin-triggered generation batch. Fires
   * BEFORE anything enters the queue — a request over this cap is
   * rejected in the admin controller with 400, no LLM call, no
   * queue entry. Useful when `AI_PROVIDER=self_hosted` (Ollama has
   * no per-call cost so `AI_MAX_JOB_COST_USD` is meaningless), and
   * defensive against a mistyped `count` on the Bedrock path too.
   */
  maxItemsPerBatch: parseInt(process.env.AI_MAX_ITEMS_PER_BATCH ?? '1000', 10),
  /**
   * Selects the generation client at boot. `bedrock` (default) uses
   * AWS Bedrock; `self_hosted` routes through OllamaClient. Any
   * other value logs a warning and falls back to bedrock. See
   * `src/modules/ai/clients/ai-generation.factory.ts`.
   */
  provider: (process.env.AI_PROVIDER ?? 'bedrock').trim().toLowerCase(),
  /**
   * Embeddings (syllabus RAG). Resolved independently of `provider` so
   * embeddings can run free on local Ollama while generation stays on
   * Bedrock (or vice versa). `AI_EMBEDDING_DIM` MUST match the model and
   * the pgvector column width (Titan v2 = 1024, bge-m3 = 1024, nomic = 768);
   * changing it later means re-embedding + a column change.
   */
  embeddingProvider: (
    process.env.AI_EMBEDDING_PROVIDER ??
    process.env.AI_PROVIDER ??
    'bedrock'
  )
    .trim()
    .toLowerCase(),
  embeddingModel:
    process.env.AI_EMBEDDING_MODEL ?? 'amazon.titan-embed-text-v2:0',
  embeddingDim: parseInt(process.env.AI_EMBEDDING_DIM ?? '1024', 10),
}));
