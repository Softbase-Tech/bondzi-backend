import { costUsd } from '../ai/ai-cost.util';

/**
 * Cost + time estimates for admin bulk-generation previews. These are
 * deliberately rough — the actual values may be 10–20% off depending on
 * prompt length — but they give admins a clear budget bound before confirm.
 */

export const TOKEN_ESTIMATES = {
  explanation: { input: 400, output: 200 },
  pmTestQuestion: { input: 300, output: 450 },
} as const;

export type ModelChoice = 'claude-haiku' | 'claude-sonnet';

export function resolveModelId(choice: ModelChoice): string {
  if (choice === 'claude-sonnet') return 'claude-sonnet-4-6';
  return 'claude-haiku-4-5-20251001';
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
