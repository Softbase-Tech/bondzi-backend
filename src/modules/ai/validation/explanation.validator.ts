/**
 * Rule-based validator for AI-generated explanations. Runs BEFORE
 * writing to `questions.explanation` — a rejected explanation lands
 * in `ai_generation_reject_log` and the question keeps its previous
 * explanation (or none). Students never see a malformed one.
 *
 * The rules mirror the explanation contract defined in the
 * instruction layer (`explanation.prompt.ts:EXPLANATION_OUTPUT_CONTRACT`):
 *
 *   • Refusal path — the JSON refusal shape surfaces as a distinct
 *     reason per its `error` code: `key_mismatch` (the model solved
 *     the question and disagrees with the provided key — remediation
 *     B1; route the QUESTION to review, this is a data-quality signal,
 *     not a generation failure), `ambiguous_question`, and everything
 *     else as `model_refused`.
 *   • Structure — must contain a `## Solution` section. A
 *     `## Worked Example` (or legacy `## Example`) section is OPTIONAL;
 *     when present it must come after the solution. Conceptual / recall
 *     questions legitimately have no worked example.
 *   • Correct-answer quoting — when the caller passes the correct
 *     option's text, the body must contain it verbatim (remediation
 *     0.8), and must NOT reference options by letter ("option B",
 *     "answer is C") — server-side shuffling makes letters stale.
 *   • Forbidden headings — only Solution / Worked Example (or legacy
 *     Example) headings are allowed.
 *   • Length — under 180 characters is a one-liner, not an explanation.
 *   • No verbatim stem — model shouldn't just parrot the question
 *     back before "explaining" it.
 *
 * The `stem` param is passed by the caller so this validator stays
 * pure (no DB reads); the caller has the question in hand from the
 * generation batch already.
 */

export type ExplanationRejectReason =
  | 'model_refused'
  | 'key_mismatch'
  | 'ambiguous_question'
  | 'missing_solution_section'
  | 'missing_worked_example_calc'
  | 'section_order_wrong'
  | 'forbidden_heading'
  | 'missing_correct_answer_text'
  | 'label_reference'
  | 'too_short'
  | 'stem_verbatim';

export type ExplanationValidationResult =
  | { ok: true; content: string; warnings: string[] }
  | { ok: false; reason: ExplanationRejectReason; detail: string };

const MIN_LENGTH_CHARS = 180;
const STEM_MATCH_PREFIX = 120;

/**
 * "The answer is B" / "option C" style references. Word-boundary +
 * single capital letter so "Option A requires..." trips but chemistry
 * like "vitamin B" does not (the pattern requires the option/answer
 * keyword immediately before the letter).
 */
const LABEL_REFERENCE =
  /\b(?:option|answer\s+is|correct\s+answer\s+is)\s+\(?([A-D])\)?(?![\w-])/i;

export function validateExplanation(
  rawText: string,
  stem: string,
  opts: {
    requireWorkedExample?: boolean;
    /**
     * When provided, the explanation body must quote this text
     * verbatim (case-insensitive) — remediation 0.8. Callers that
     * can't supply it (legacy paths) skip the check.
     */
    correctOptionText?: string;
  } = {},
): ExplanationValidationResult {
  const trimmed = rawText.trim();
  const warnings: string[] = [];

  // Refusal path — the shell tells the model to return a JSON refusal
  // when out-of-syllabus / key-mismatch / ambiguous. It arrives as
  // literal JSON text at the top of the output.
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as {
        error?: unknown;
        detail?: unknown;
      };
      if (typeof parsed.error === 'string' && parsed.error.length > 0) {
        const detail =
          typeof parsed.detail === 'string' ? parsed.detail : parsed.error;
        if (parsed.error === 'key_mismatch') {
          return { ok: false, reason: 'key_mismatch', detail };
        }
        if (parsed.error === 'ambiguous_question') {
          return { ok: false, reason: 'ambiguous_question', detail };
        }
        return { ok: false, reason: 'model_refused', detail };
      }
    } catch {
      // Not a JSON refusal — fall through and validate as markdown.
    }
  }

  if (trimmed.length < MIN_LENGTH_CHARS) {
    return {
      ok: false,
      reason: 'too_short',
      detail: `${trimmed.length} chars (min ${MIN_LENGTH_CHARS}); one-liner, not an explanation`,
    };
  }

  // Structure — `## Solution` is required; the worked example is optional.
  // Match ATX headings at line-start (line-anchored so a mention of
  // "example" inside a paragraph doesn't count). Accept ANY heading level
  // (`#`–`######`) — models routinely emit `### Solution` instead, and
  // rejecting a good explanation over one extra `#` is a validator bug. The
  // worked example may be titled `## Worked Example` (current) or `## Example`
  // (legacy).
  const solutionMatch = /^\s*#{1,6}\s+Solution\b/im.exec(trimmed);
  const exampleMatch = /^\s*#{1,6}\s+(?:Worked\s+Example|Example)\b/im.exec(
    trimmed,
  );
  if (!solutionMatch) {
    return {
      ok: false,
      reason: 'missing_solution_section',
      detail: 'no `## Solution` heading found',
    };
  }
  // The worked example is optional, but if the model DID emit one it must
  // come after the solution (a client that splits on the heading would
  // otherwise mis-assign the sections).
  if (exampleMatch && exampleMatch.index < solutionMatch.index) {
    return {
      ok: false,
      reason: 'section_order_wrong',
      detail: '`## Worked Example` appeared before `## Solution`',
    };
  }

  // Forbidden extra headings — only Solution / Worked Example / Example
  // are allowed (codex finding). Anything else means the model invented
  // structure the client can't render.
  const headingRe = /^\s*#{1,6}\s+(.+)$/gim;
  let h: RegExpExecArray | null;
  while ((h = headingRe.exec(trimmed)) !== null) {
    const title = h[1].trim();
    if (!/^(Solution|Worked\s+Example|Example)\b/i.test(title)) {
      return {
        ok: false,
        reason: 'forbidden_heading',
        detail: `unexpected heading "${title.slice(0, 60)}" — only Solution / Worked Example allowed`,
      };
    }
  }

  // Quantitative subjects (Physics / Chemistry / Mathematics /
  // Additional Mathematics / Accounting / Economics / …) MUST ship
  // both sections. A one-line "why the answer is right" isn't good
  // enough for a student who needs to see the method demonstrated
  // on a fresh problem.
  if (opts.requireWorkedExample && !exampleMatch) {
    return {
      ok: false,
      reason: 'missing_worked_example_calc',
      detail:
        'Quantitative subject requires a `## Worked Example` section in addition to `## Solution`.',
    };
  }

  // Remediation 0.8 — the correct option's TEXT must be quoted.
  // Normalised comparison (whitespace + case) so LaTeX spacing or a
  // trailing period doesn't false-negative. Warn-only when the option
  // text is very short (≤ 3 chars, e.g. "2" or "Na") — substring
  // presence of such fragments proves nothing either way.
  if (opts.correctOptionText && opts.correctOptionText.trim().length > 3) {
    const bodyNorm = normaliseWhitespace(trimmed);
    const answerNorm = normaliseWhitespace(opts.correctOptionText);
    if (!bodyNorm.includes(answerNorm)) {
      return {
        ok: false,
        reason: 'missing_correct_answer_text',
        detail: `explanation never quotes the correct option text "${opts.correctOptionText.slice(0, 60)}"`,
      };
    }
  }

  // Letter references go stale after the server-side option shuffle.
  const labelHit = LABEL_REFERENCE.exec(trimmed);
  if (labelHit) {
    return {
      ok: false,
      reason: 'label_reference',
      detail: `explanation references an option by letter ("${labelHit[0]}") — must quote option text instead`,
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

  return { ok: true, content: trimmed, warnings };
}

function normaliseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}
