import { registerAs } from '@nestjs/config';

/**
 * Spec §9.3 env vars:
 *   AI_DEFAULT_MODEL=claude-haiku-4-5-20251001    # fast/cheap (bulk)
 *   AI_QUALITY_MODEL=claude-sonnet-4-6            # higher-quality explanations
 *   AI_MAX_JOB_COST_USD=500                       # per-job hard cap
 *
 * Legacy names AI_FAST_MODEL / AI_EXPLANATION_MODEL are kept as fallbacks so
 * older env files keep working; prefer the spec-canonical names going forward.
 */
export default registerAs('ai', () => ({
  anthropicApiKey: process.env.ANTHROPIC_API_KEY as string,
  openaiApiKey: process.env.OPENAI_API_KEY as string,
  explanationModel:
    process.env.AI_QUALITY_MODEL ??
    process.env.AI_EXPLANATION_MODEL ??
    'claude-sonnet-4-6',
  fastModel:
    process.env.AI_DEFAULT_MODEL ??
    process.env.AI_FAST_MODEL ??
    'claude-haiku-4-5-20251001',
  failoverModel: process.env.AI_FAILOVER_MODEL ?? 'gpt-4o-mini',
  dailyBudgetUsd: parseFloat(process.env.AI_DAILY_BUDGET_USD ?? '50'),
  perUserDailyLimit: parseInt(process.env.AI_PER_USER_DAILY_LIMIT ?? '50', 10),
  maxJobCostUsd: parseFloat(process.env.AI_MAX_JOB_COST_USD ?? '500'),
}));
