import { AiReview } from '../entities/ai-review.entity';
import { inlineMathInMarkdown } from '../../../common/utils/math.util';

export interface AiReviewListItem {
  id: string;
  subjectScope: string;
  summary: string;
  mode: 'bootstrap' | 'personalised';
  model: string;
  generatedAt: string;
}

export interface AiReviewFull extends AiReviewListItem {
  /** The full 6-section markdown report. */
  content: string;
}

export interface AiReviewQuota {
  tier: 'free' | 'plus' | 'pro';
  /** Monthly allowance for this tier. 0 for Free (locked). */
  limit: number;
  /** Personalised reviews generated in the current Accra month. */
  used: number;
  remaining: number;
  /** False when Free, or when the monthly allowance is exhausted. */
  canGenerate: boolean;
  /** The most recent review (light) so the Home card renders in one call. */
  latest: AiReviewListItem | null;
}

export function toAiReviewListItem(row: AiReview): AiReviewListItem {
  return {
    id: row.id,
    subjectScope: row.subjectScope,
    summary: row.summary,
    mode: row.mode,
    model: row.model,
    generatedAt: row.createdAt.toISOString(),
  };
}

export function toAiReviewFull(row: AiReview): AiReviewFull {
  return {
    ...toAiReviewListItem(row),
    // Inline `$...$` LaTeX to the SVG shape the mobile MathMarkdown
    // renderer expects — the explanations controller does the same
    // treatment; this serializer was forgetting it, so any math a
    // review emitted reached the client as literal `\frac{}` text
    // (remediation C-zero #6).
    content: inlineMathInMarkdown(row.content),
  };
}
