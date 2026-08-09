import { costUsd } from '../ai/ai-cost.util';

/**
 * Cost + time estimates for admin bulk-generation previews.
 *
 * Calibration note (TODO after one week of prod):
 *   These numbers are the audit's original guesses, NOT measurements.
 *   Sonnet math explanations routinely run 600–900 output tokens — the
 *   200 default here was undercounting actual cost by 3–4× during the
 *   audit period. We persist actual input/output tokens to ai_usage_log
 *   on every Bedrock call (see ai.service.logUsage); after a week of
 *   real traffic we should recalibrate from the median actual usage
 *   per (model, action). Until then over-estimate via the headroom in
 *   AI_MAX_JOB_COST_USD and the cosign gate.
 *
 *   Recalibration query (run after >=7 days of data):
 *     select
 *       model,
 *       action,
 *       percentile_cont(0.5) within group (order by input_tokens) as p50_input,
 *       percentile_cont(0.5) within group (order by output_tokens) as p50_output,
 *       percentile_cont(0.95) within group (order by output_tokens) as p95_output,
 *       count(*) as n
 *     from ai_usage_log
 *     where created_at > now() - interval '7 days'
 *       and input_tokens is not null
 *       and output_tokens is not null
 *     group by model, action;
 *
 *   Use the P95 of output_tokens for the estimate (the gate's job is to
 *   over-count, not under-count; we'd rather reject a job that turns out
 *   fine than approve one that overruns AI_DAILY_BUDGET_USD).
 *   Then bump the constants here, and the gate calibrates itself.
 */

export const TOKEN_ESTIMATES = {
  // Output must be an UPPER bound, not an average — the estimate is the
  // denominator of the runaway-cost circuit breaker (JOB_COST_CAP_MULTIPLIER),
  // so under-counting makes real jobs abort. Explanations are generated with
  // maxTokens=600 and real math explanations routinely fill it, so the output
  // estimate tracks that ceiling; input covers a question + options + system
  // prompt. Recalibrate from /admin/ai/calibration once there are samples.
  explanation: { input: 500, output: 600 },
  pmTestQuestion: { input: 300, output: 450 },
} as const;

export type ModelChoice = 'claude-haiku' | 'claude-sonnet';

/**
 * Returns the Bedrock model ID for an admin-facing model choice. The
 * `anthropic.<name>-v1:0` form is what `BedrockClient.invoke()` and the
 * `costUsd()` pricing table expect. Update if AWS publishes newer revisions.
 */
export function resolveModelId(choice: ModelChoice): string {
  // Bedrock requires a cross-region inference profile ID (geo-prefixed)
  // for on-demand invocation of these models — the bare `anthropic.*`
  // model ID is rejected. `eu.` matches our eu-central-1 deployment.
  if (choice === 'claude-sonnet') {
    return 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0';
  }
  return 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
}

export interface GenerationEstimate {
  totalItems: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  estimatedSeconds: number;
}

export function estimateExplanationJob(
  count: number,
  choice: ModelChoice,
): GenerationEstimate {
  const model = resolveModelId(choice);
  const inputTokens = count * TOKEN_ESTIMATES.explanation.input;
  const outputTokens = count * TOKEN_ESTIMATES.explanation.output;
  const cost = costUsd(model, inputTokens, outputTokens);
  return {
    totalItems: count,
    model,
    inputTokens,
    outputTokens,
    estimatedCostUsd: Number(cost.toFixed(4)),
    // Rough throughput: 1 item per second sustained on Haiku, 2s on Sonnet.
    estimatedSeconds: count * (choice === 'claude-sonnet' ? 2 : 1),
  };
}

export function estimatePmTestJob(
  count: number,
  choice: ModelChoice,
  batchSize: number,
): GenerationEstimate {
  const model = resolveModelId(choice);
  const batches = Math.ceil(count / Math.max(1, batchSize));
  // Each batch shares one prompt so per-item input trends down with batchSize.
  const inputTokens =
    batches *
    (TOKEN_ESTIMATES.pmTestQuestion.input +
      batchSize * 30); /* prompt + per-item overhead */
  const outputTokens = count * TOKEN_ESTIMATES.pmTestQuestion.output;
  const cost = costUsd(model, inputTokens, outputTokens);
  return {
    totalItems: count,
    model,
    inputTokens,
    outputTokens,
    estimatedCostUsd: Number(cost.toFixed(4)),
    estimatedSeconds: batches * (choice === 'claude-sonnet' ? 6 : 3),
  };
}
