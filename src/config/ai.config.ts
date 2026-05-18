import { registerAs } from '@nestjs/config';

/**
 * AI configuration. Provider is now AWS Bedrock — auth lands through the
 * standard AWS SDK chain (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY or an
 * IAM role on the instance), so there are no Anthropic / OpenAI keys to
 * configure here any more.
 *
 * Spec §9.3 env vars (in Bedrock form):
 *   AI_DEFAULT_MODEL=anthropic.claude-haiku-4-5-20251001-v1:0   # fast/cheap
 *   AI_QUALITY_MODEL=anthropic.claude-sonnet-4-5-20250929-v1:0  # higher quality
 *   AI_MAX_JOB_COST_USD=500                                     # per-job hard cap
 *   AI_BEDROCK_MAX_RETRIES=3                                    # SDK retry count
 *   AWS_REGION=eu-central-1                                     # Bedrock region
 *
 * Legacy names AI_FAST_MODEL / AI_EXPLANATION_MODEL are kept as fallbacks so
 * older env files keep working; prefer the spec-canonical names going forward.
 */
export default registerAs('ai', () => ({
  explanationModel:
    process.env.AI_QUALITY_MODEL ??
    process.env.AI_EXPLANATION_MODEL ??
    'anthropic.claude-sonnet-4-5-20250929-v1:0',
  fastModel:
    process.env.AI_DEFAULT_MODEL ??
    process.env.AI_FAST_MODEL ??
    'anthropic.claude-haiku-4-5-20251001-v1:0',
  dailyBudgetUsd: parseFloat(process.env.AI_DAILY_BUDGET_USD ?? '50'),
  perUserDailyLimit: parseInt(process.env.AI_PER_USER_DAILY_LIMIT ?? '50', 10),
  maxJobCostUsd: parseFloat(process.env.AI_MAX_JOB_COST_USD ?? '500'),
  // Jobs over this estimated cost wait in PENDING_APPROVAL for a second
  // admin's sign-off. 0 disables the gate entirely.
  cosignThresholdUsd: parseFloat(process.env.AI_COSIGN_THRESHOLD_USD ?? '50'),
  bedrockMaxRetries: parseInt(process.env.AI_BEDROCK_MAX_RETRIES ?? '3', 10),
}));
