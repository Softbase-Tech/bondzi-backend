/**
 * Rule-based validator for AI-generated explanations. Runs BEFORE
 * writing to `questions.explanation` — a rejected explanation lands
 * in `ai_generation_reject_log` and the question keeps its previous
 * explanation (or none). Students never see a malformed one.
 *
 * The rules mirror the explanation contract defined in the
 * instruction layer (`explanation.prompt.ts:EXPLANATION_OUTPUT_CONTRACT`):
 *
 *   • Refusal path — if the model returned the JSON refusal shape,
 *     surface as `model_refused` (distinct reason so ops can tell
 *     "topic out of coverage" apart from "prompt drift").
 *   • Structure — must contain a `## Solution` section AND a
 *     `## Example` section, in that order. The `## Example` section
 *     is the extensive-worked-example requirement from your spec.
 *   • Length — under 400 characters typically means the worked
 *     example is missing or the solution is a one-liner. Reject.
 *   • No verbatim stem — model shouldn't just parrot the question
 *     back before "explaining" it. Reject when the first 120
 *     characters of the stem appear verbatim in the output (line-
 *     start match to avoid a false positive when a stem word
 *     legitimately reappears mid-solution).
 *
 * The `stem` param is passed by the caller so this validator stays
 * pure (no DB reads); the caller has the question in hand from the
 * generation batch already.
 */

export type ExplanationRejectReason =
  | 'model_refused'
  | 'missing_solution_section'
  | 'missing_example_section'
  | 'section_order_wrong'
  | 'too_short'
  | 'stem_verbatim';

export type ExplanationValidationResult =
  | { ok: true; content: string }
  | { ok: false; reason: ExplanationRejectReason; detail: string };

const MIN_LENGTH_CHARS = 400;
const STEM_MATCH_PREFIX = 120;

export function validateExplanation(
  rawText: string,
  stem: string,
): ExplanationValidationResult {
  const trimmed = rawText.trim();

  // Refusal path — the shell tells the model to return a JSON refusal
  // when out-of-syllabus / schema-impossible. It arrives as literal
  // JSON text at the top of the output.
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
      // Not a JSON refusal — fall through and validate as markdown.
    }
  }

  if (trimmed.length < MIN_LENGTH_CHARS) {
    return {
      ok: false,
      reason: 'too_short',
      detail: `${trimmed.length} chars (min ${MIN_LENGTH_CHARS}); likely missing worked example`,
    };
  }

  // Structure — both required sections, in the right order. Match a
  // `Solution` / `Example` ATX heading at line-start (line-anchored so a
  // mention of "example" inside a paragraph doesn't count). The prompt asks
  // for `## Solution`, but accept ANY heading level (`#`–`######`) — models
  // routinely emit `### Solution` instead, and rejecting a perfectly good
  // explanation over one extra `#` is a validator bug, not a bad response.
  const solutionMatch = /^\s*#{1,6}\s+Solution\b/im.exec(trimmed);
  const exampleMatch = /^\s*#{1,6}\s+Example\b/im.exec(trimmed);
  if (!solutionMatch) {
    return {
      ok: false,
      reason: 'missing_solution_section',
      detail: 'no `## Solution` heading found',
    };
  }
  if (!exampleMatch) {
    return {
      ok: false,
      reason: 'missing_example_section',
      detail:
        'no `## Example` heading found — extensive worked example is required',
    };
  }
  if (exampleMatch.index < solutionMatch.index) {
    return {
      ok: false,
      reason: 'section_order_wrong',
      detail: '`## Example` appeared before `## Solution`',
    };
  }

  // Verbatim-stem check. Compare the first STEM_MATCH_PREFIX chars of
  // the stem (normalised whitespace) against a normalised version of
  // the output. A hit typically means the model prefixed the output
  // with the question text — which is verbose and not what we want.
  const stemNormalised = normaliseWhitespace(stem).slice(0, STEM_MATCH_PREFIX);
  if (stemNormalised.length >= 40) {
    const outNormalised = normaliseWhitespace(trimmed);
    if (outNormalised.includes(stemNormalised)) {
      return {
        ok: false,
        reason: 'stem_verbatim',
        detail: 'output contains the question stem verbatim',
      };
    }
  }

  return { ok: true, content: trimmed };
}

function normaliseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}
