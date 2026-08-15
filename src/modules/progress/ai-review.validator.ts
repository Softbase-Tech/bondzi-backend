import { AI_REVIEW_SECTIONS } from './ai-review.prompt';

/**
 * Validates an AI Study Review before it is persisted and charged. A
 * malformed review must NOT consume the user's monthly quota — the
 * caller re-throws so the generation reads as a transient failure the
 * student can retry, not a spent unit.
 *
 * Checks:
 *   - not the JSON refusal shape ({ error, detail })
 *   - above a minimum length (a one-liner means the model bailed)
 *   - contains all six required `## ` section headings, in order
 *
 * On success returns the trimmed content plus an extracted `summary`
 * (the teaser paragraph before the first heading) for the Home card.
 */

export type AiReviewRejectReason =
  | 'model_refused'
  | 'too_short'
  | 'missing_sections'
  | 'section_order_wrong';

export type AiReviewValidationResult =
  | { ok: true; content: string; summary: string }
  | { ok: false; reason: AiReviewRejectReason; detail: string };

const MIN_LENGTH_CHARS = 400;
const SUMMARY_MAX_CHARS = 280;

export function validateAiReview(rawText: string): AiReviewValidationResult {
  const trimmed = rawText.trim();

  // Refusal path — the model may return a JSON refusal shape.
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as {
        error?: unknown;
        detail?: unknown;
      };
      if (typeof parsed.error === 'string' && parsed.error.length > 0) {
        return {
          ok: false,
          reason: 'model_refused',
          detail:
            typeof parsed.detail === 'string' ? parsed.detail : parsed.error,
        };
      }
    } catch {
      // Not JSON — fall through and validate as markdown.
    }
  }

  if (trimmed.length < MIN_LENGTH_CHARS) {
    return {
      ok: false,
      reason: 'too_short',
      detail: `${trimmed.length} chars (min ${MIN_LENGTH_CHARS})`,
    };
  }

  // Locate each required section heading (any level 2–3, exact label).
  let lastIndex = -1;
  for (const section of AI_REVIEW_SECTIONS) {
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`^\\s*#{2,3}\\s+${escaped}\\s*$`, 'im').exec(
      trimmed,
    );
    if (!match) {
      return {
        ok: false,
        reason: 'missing_sections',
        detail: `missing "## ${section}" section`,
      };
    }
    if (match.index < lastIndex) {
      return {
        ok: false,
        reason: 'section_order_wrong',
        detail: `"## ${section}" appeared out of order`,
      };
    }
    lastIndex = match.index;
  }

  return { ok: true, content: trimmed, summary: extractSummary(trimmed) };
}

/**
 * The teaser is the text before the first `##` heading. If the model
 * skipped the lead paragraph, fall back to the first line of the first
 * section so the card is never blank.
 */
function extractSummary(content: string): string {
  const firstHeading = content.search(/^\s*#{2,3}\s+/m);
  let lead = firstHeading > 0 ? content.slice(0, firstHeading).trim() : '';

  if (!lead) {
    // No lead paragraph — take the first non-heading, non-empty line.
    lead =
      content
        .split('\n')
        .map((l) => l.trim())
        .find(
          (l) => l.length > 0 && !/^#{1,6}\s/.test(l) && !/^[-*]\s/.test(l),
        ) ?? '';
  }

  // Strip markdown emphasis for a clean plain-text teaser.
  const plain = lead.replace(/\*\*/g, '').replace(/[*_`]/g, '').trim();
  return plain.length > SUMMARY_MAX_CHARS
    ? `${plain.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`
    : plain;
}
