import { looksLikeCalcQuestion } from '../../../common/utils/looks-like-calc.util';

/**
 * Rule-based validator for AI-generated multiple-choice question
 * batches. Runs BEFORE any insert into `pm_test_questions` or
 * `questions` — a rejected row lands in `ai_generation_reject_log`
 * with the reason + the model's raw output; nothing hits the
 * students-facing tables.
 *
 * The rules mirror what the instruction layer's system-shell asks
 * for. Enforcing them at the wire keeps the answer key correct even
 * when the model — especially a weaker local one — hasn't fully
 * internalised the prompt.
 *
 * Two entry points:
 *
 *   `validateQuestionBatch`        — all-or-nothing (legacy behavior,
 *                                    kept for callers/tests that want
 *                                    a single verdict).
 *   `validateQuestionBatchSalvage` — per-item (remediation 0.5): good
 *                                    items are returned for insert,
 *                                    bad items are returned with their
 *                                    reasons so the caller can log
 *                                    them individually and run ONE
 *                                    reflexion retry on just the
 *                                    failed ones. One bad item no
 *                                    longer bills the whole batch.
 *
 * Answer-key CORRECTNESS is not checked here — that is the blind
 * second-pass verifier's job (answer-verifier.service.ts), which runs
 * after this validator and before the DB insert.
 */

export type QuestionRejectReason =
  | 'schema_invalid'
  | 'not_an_array'
  | 'empty_batch'
  | 'empty_stem'
  | 'no_options'
  | 'wrong_option_count'
  | 'empty_option'
  | 'no_correct'
  | 'multiple_correct'
  | 'duplicate_option_text'
  | 'correct_answer_field_mismatch'
  | 'meta_syllabus_reference'
  | 'stem_leaks_answer'
  | 'stem_too_short'
  | 'stem_too_long'
  | 'trivia_meta_question'
  | 'references_missing_stimulus'
  | 'all_or_none_option'
  | 'missing_worked_example_calc'
  | 'model_refused';

/**
 * Phrases that mean "the model is testing the syllabus document itself
 * rather than the subject matter". Matched case-insensitively against
 * both stems and explanations. Present tense of "learners <verb>" is
 * the NaCCA outcome-statement voice; if it survives into the question,
 * the model is echoing the indicator rather than authoring a real
 * WAEC-style question.
 */
const META_SYLLABUS_PATTERNS: RegExp[] = [
  /\baccording to the syllabus\b/i,
  /\bas stated in the syllabus\b/i,
  /\bthe syllabus (?:explicitly )?states\b/i,
  /\bthe curriculum states\b/i,
  /\bas noted in the curriculum\b/i,
  /\bin the syllabus\b/i,
  /\bper the (?:syllabus|curriculum)\b/i,
  /\blearners will (?:assess|identify|describe|analyse|explain|classify|demonstrate|discuss)\b/i,
  /\blearners (?:assess|identify|describe|analyse|explain|classify|demonstrate|discuss)\b/i,
];

/**
 * Bare-word ban — applied to the STEM ONLY (remediation 1.6). The old
 * blanket check over stem+explanation rejected legitimate items (a
 * Social Studies question about Ghana's education system whose
 * explanation mentions the school curriculum as subject matter). The
 * phrase-level patterns above still cover both stem and explanation —
 * they catch the actual failure mode.
 */
const BANNED_WORDS: RegExp = /\b(syllabus|curriculum)\b/i;

/**
 * Meta-institution stems ("Which year did WAEC introduce…", "Who is
 * the current chief examiner…") — WAEC tests the subject, not itself.
 */
const TRIVIA_META_PATTERNS: RegExp[] = [
  /\b(waec|wassce|bece|novdec|nacca|ministry of education)\b/i,
  /\bchief examiner\b/i,
  /\bexam board\b/i,
];

/**
 * Phantom-stimulus references. Generated PM-Test items have NO
 * attached stimulus (no passage, no image, no shared table — the
 * pm_test schema has no stimulus support), so a stem that points at
 * one is broken for the student the moment it renders. English and
 * Biology are the high-risk subjects: comprehension and diagram
 * framing is the models' default register there.
 *
 * Passages/extracts/poems are ALWAYS phantom — a real passage cannot
 * fit inside the 60-word stem cap. Diagram/figure/graph/map/chart
 * references are always phantom too — models cannot draw, and ASCII
 * art is banned. Table references are checked separately: a stem may
 *legitimately contain its own inline markdown table.
 */
const PHANTOM_STIMULUS_PATTERNS: RegExp[] = [
  /\b(?:the|this|a) (?:passage|extract|poem|comprehension)\b/i,
  /\baccording to the (?:passage|extract|poem|text|diagram|figure|graph|map|chart)\b/i,
  /\b(?:the|this) (?:diagram|figure|graph|map|chart|illustration|picture|image)s? (?:above|below|shown|provided|given)\b/i,
  /\b(?:in|from|on) the (?:diagram|figure|graph|map|chart|illustration|picture|image)\b/i,
  /\buse the .{0,40}(?:above|below) to answer\b/i,
  /\b(?:shown|given|provided) (?:above|below)\b/i,
];
/** Table references are phantom only when no inline table follows. */
const TABLE_REFERENCE: RegExp =
  /\b(?:the|this) table (?:above|below|shown|provided|given)\b|\b(?:in|from) the table\b/i;
/** Crude-but-sufficient inline markdown table detector (a pipe row). */
const INLINE_TABLE: RegExp = /\|.+\|/;

/**
 * "All of the above" / "None of the above" — banned per the system
 * shell. WAEC style requires four distinct fact-based options.
 */
const ALL_OR_NONE: RegExp =
  /^(?:\s*)(all of the above|none of the above|both a and b|both a & b|a and b only|a and c only|b and c only|a, b and c|a b and c)(?:\s*)$/i;

export interface ParsedOption {
  label: string;
  body: string;
  isCorrect: boolean;
}

export interface ParsedQuestion {
  body: string;
  difficulty: 'easy' | 'medium' | 'hard';
  options: ParsedOption[];
  explanation: string;
  /** Non-fatal quality notes (option-length ratio, difficulty override…). */
  warnings: string[];
}

export interface ItemReject {
  /** 0-based index of the item in the model's returned array. */
  index: number;
  reason: QuestionRejectReason;
  detail: string;
}

export type QuestionValidationResult =
  | { ok: true; value: ParsedQuestion[] }
  | {
      ok: false;
      reason: QuestionRejectReason;
      detail: string;
      /** 0-based index of the question in the batch that failed, if applicable. */
      failedIndex?: number;
    };

export type QuestionSalvageResult =
  | {
      ok: true;
      /** Items that passed every per-item rule, in returned order. */
      value: ParsedQuestion[];
      /** Items that failed, with per-item reasons — log + reflexion-retry these. */
      rejected: ItemReject[];
      /** Batch-level quality notes (count mismatch etc.). */
      warnings: string[];
    }
  | {
      /** Batch-level failure — nothing salvageable (bad JSON, refusal…). */
      ok: false;
      reason: QuestionRejectReason;
      detail: string;
    };

/** How many options we expect. WAEC MCQ is always 4. */
const EXPECTED_OPTION_COUNT = 4;
/** Stem word bounds — mirror the system shell's promise (min 6, max 60). */
const MIN_STEM_WORDS = 6;
const MAX_STEM_WORDS = 60;
/** "Correct is longest" LLM tell — warn when longest/shortest exceeds this. */
const OPTION_LENGTH_RATIO_WARN = 1.6;

export interface QuestionValidationOpts {
  /**
   * When true, every question in the batch is treated as
   * calculation-shaped — its inline explanation MUST include
   * `## Worked Example`. Callers flip this when the SUBJECT is
   * quantitative (Physics / Chemistry / Maths / …).
   *
   * Regardless of this flag, an INDIVIDUAL question inside a
   * non-quantitative batch is checked per-question via
   * `looksLikeCalcQuestion` — so a numeric Economics item still
   * gets the same worked-example enforcement as a Maths item.
   */
  requireWorkedExampleForBatch?: boolean;
  /**
   * The difficulty the admin requested for this batch. The REQUEST is
   * authoritative (remediation 1.5): an item whose self-graded
   * difficulty disagrees is overridden to the requested value with a
   * warning, instead of the old silent coerce-to-medium which let the
   * model rewrite the admin's difficulty mix.
   */
  requestedDifficulty?: 'easy' | 'medium' | 'hard';
  /**
   * How many items the batch asked for. A shortfall beyond 1 is
   * reported as a batch warning (informational — with per-item
   * salvage a short batch is still worth keeping); an overage is
   * truncated to the requested count.
   */
  expectedCount?: number;
}

/**
 * All-or-nothing validation (legacy behavior): the first failing item
 * fails the whole batch. Kept for callers/tests that want a single
 * verdict; new pipeline code should prefer `validateQuestionBatchSalvage`.
 */
export function validateQuestionBatch(
  rawText: string,
  opts: QuestionValidationOpts = {},
): QuestionValidationResult {
  const parsed = parseBatch(rawText);
  if (!parsed.ok) return parsed;

  const out: ParsedQuestion[] = [];
  for (let i = 0; i < parsed.items.length; i++) {
    const res = validateSingleQuestion(parsed.items[i], i, opts);
    if (!res.ok) {
      return {
        ok: false,
        reason: res.reason,
        detail: res.detail,
        failedIndex: i,
      };
    }
    out.push(res.value);
  }
  return { ok: true, value: out };
}

/**
 * Per-item validation with salvage (remediation 0.5). Batch-level
 * failures (unparseable JSON, refusal object, empty array) still fail
 * the whole call; item-level failures only drop that item.
 */
export function validateQuestionBatchSalvage(
  rawText: string,
  opts: QuestionValidationOpts = {},
): QuestionSalvageResult {
  const parsed = parseBatch(rawText);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, detail: parsed.detail };
  }

  const warnings: string[] = [];
  let items = parsed.items;
  if (opts.expectedCount != null) {
    if (items.length > opts.expectedCount) {
      warnings.push(
        `model returned ${items.length} items for a batch of ${opts.expectedCount}; extra items truncated`,
      );
      items = items.slice(0, opts.expectedCount);
    } else if (items.length < opts.expectedCount - 1) {
      warnings.push(
        `model returned ${items.length} items for a batch of ${opts.expectedCount}`,
      );
    }
  }

  const value: ParsedQuestion[] = [];
  const rejected: ItemReject[] = [];
  for (let i = 0; i < items.length; i++) {
    const res = validateSingleQuestion(items[i], i, opts);
    if (res.ok) value.push(res.value);
    else rejected.push({ index: i, reason: res.reason, detail: res.detail });
  }
  return { ok: true, value, rejected, warnings };
}

// ---------------------------------------------------------------------------

type BatchParse =
  | { ok: true; items: unknown[] }
  | { ok: false; reason: QuestionRejectReason; detail: string };

function parseBatch(rawText: string): BatchParse {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { ok: false, reason: 'schema_invalid', detail: 'empty output' };
  }

  // Some models still wrap in markdown fences despite instructions
  // saying "no fences". Strip a leading ```json / ``` and trailing ```.
  const unfenced = stripFences(trimmed);

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch (err) {
    return {
      ok: false,
      reason: 'schema_invalid',
      detail: `JSON.parse failed: ${(err as Error).message}`,
    };
  }

  // Model refusal path — the system shell instructs the model to
  // return {"error":"out_of_scope", "detail":"..."} when the topic
  // isn't covered. Surface as a distinct reason so the admin can
  // tell "prompt drift" apart from "genuine coverage gap".
  if (isRefusalObject(parsed)) {
    return {
      ok: false,
      reason: 'model_refused',
      detail:
        typeof (parsed as { detail?: unknown }).detail === 'string'
          ? (parsed as { detail: string }).detail
          : 'model refused',
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      reason: 'not_an_array',
      detail: `expected top-level JSON array, got ${typeof parsed}`,
    };
  }
  if (parsed.length === 0) {
    return { ok: false, reason: 'empty_batch', detail: 'array had 0 items' };
  }
  return { ok: true, items: parsed };
}

type SingleResult =
  | { ok: true; value: ParsedQuestion }
  | { ok: false; reason: QuestionRejectReason; detail: string };

function validateSingleQuestion(
  raw: unknown,
  i: number,
  opts: QuestionValidationOpts,
): SingleResult {
  const q = raw as Record<string, unknown>;
  if (!q || typeof q !== 'object') {
    return {
      ok: false,
      reason: 'schema_invalid',
      detail: `item ${i} is not an object`,
    };
  }
  const warnings: string[] = [];
  const body = typeof q.body === 'string' ? q.body.trim() : '';
  if (!body) {
    return {
      ok: false,
      reason: 'empty_stem',
      detail: `item ${i} has empty body`,
    };
  }

  // Stem length bounds. 6 words is the shortest a real WAEC stem gets;
  // above 60 the item is testing reading speed, not the subject —
  // both are promised by the shell and now enforced (remediation 1.5).
  const stemWordCount = body.split(/\s+/).filter((w) => w.length > 0).length;
  if (stemWordCount < MIN_STEM_WORDS) {
    return {
      ok: false,
      reason: 'stem_too_short',
      detail: `item ${i} stem has ${stemWordCount} words; minimum is ${MIN_STEM_WORDS}`,
    };
  }
  if (stemWordCount > MAX_STEM_WORDS) {
    return {
      ok: false,
      reason: 'stem_too_long',
      detail: `item ${i} stem has ${stemWordCount} words; maximum is ${MAX_STEM_WORDS}`,
    };
  }

  // Meta-syllabus phrasing. The whole class of "According to the
  // syllabus…" questions dies here — the phrase patterns match against
  // both stem and explanation; the bare-word ban is stem-only
  // (remediation 1.6) so legitimate subject matter about Ghana's
  // education system isn't false-positived via its explanation.
  const rawExplanation = typeof q.explanation === 'string' ? q.explanation : '';
  const combined = `${body}\n${rawExplanation}`;
  const metaPhrase = META_SYLLABUS_PATTERNS.find((r) => r.test(combined));
  if (metaPhrase) {
    return {
      ok: false,
      reason: 'meta_syllabus_reference',
      detail: `item ${i} contains banned meta-syllabus phrase: ${metaPhrase.source}`,
    };
  }
  if (BANNED_WORDS.test(body)) {
    return {
      ok: false,
      reason: 'meta_syllabus_reference',
      detail: `item ${i} stem references "syllabus" or "curriculum" — test the subject matter, not the document`,
    };
  }

  // Phantom-stimulus stems — the item references a passage / diagram /
  // table that does not exist in the generated format. Checked on the
  // stem only; explanations may legitimately discuss e.g. "a diagram"
  // in the abstract.
  const phantomHit = PHANTOM_STIMULUS_PATTERNS.find((r) => r.test(body));
  if (phantomHit) {
    return {
      ok: false,
      reason: 'references_missing_stimulus',
      detail: `item ${i} stem references a stimulus that does not exist (${phantomHit.source.slice(0, 60)}) — generated items must be self-contained`,
    };
  }
  if (TABLE_REFERENCE.test(body) && !INLINE_TABLE.test(body)) {
    return {
      ok: false,
      reason: 'references_missing_stimulus',
      detail: `item ${i} stem references a table but contains no inline table`,
    };
  }

  // Trivia questions about WAEC/NaCCA/the exam board. Same
  // pedagogical mistake: the question tests the institution
  // instead of the subject.
  const triviaHit = TRIVIA_META_PATTERNS.find((r) => r.test(body));
  if (triviaHit) {
    return {
      ok: false,
      reason: 'trivia_meta_question',
      detail: `item ${i} stem references the exam institution: ${triviaHit.source}`,
    };
  }

  const rawOptions = q.options;
  if (!Array.isArray(rawOptions)) {
    return {
      ok: false,
      reason: 'no_options',
      detail: `item ${i} missing options array`,
    };
  }
  if (rawOptions.length !== EXPECTED_OPTION_COUNT) {
    return {
      ok: false,
      reason: 'wrong_option_count',
      detail: `item ${i} has ${rawOptions.length} options; expected ${EXPECTED_OPTION_COUNT}`,
    };
  }

  const options: ParsedOption[] = [];
  const seenTexts = new Set<string>();
  let correctCount = 0;
  for (let j = 0; j < rawOptions.length; j++) {
    const opt = rawOptions[j] as Record<string, unknown>;
    if (!opt || typeof opt !== 'object') {
      return {
        ok: false,
        reason: 'schema_invalid',
        detail: `item ${i} option ${j} not an object`,
      };
    }
    const label = typeof opt.label === 'string' ? opt.label.trim() : '';
    const optBody = typeof opt.body === 'string' ? opt.body.trim() : '';
    const isCorrect = opt.isCorrect === true;
    if (!optBody) {
      return {
        ok: false,
        reason: 'empty_option',
        detail: `item ${i} option ${label || j} has empty body`,
      };
    }
    // Duplicate option text. Case-insensitive because "Water" vs
    // "water" is still a dupe from the student's POV.
    const key = optBody.toLowerCase();
    if (seenTexts.has(key)) {
      return {
        ok: false,
        reason: 'duplicate_option_text',
        detail: `item ${i} has duplicate option text: "${optBody.slice(0, 60)}"`,
      };
    }
    seenTexts.add(key);

    // "All of the above" / "None of the above" / "Both A and B" —
    // banned per system shell. Even if the model gets them factually
    // right, they read as filler and inflate accuracy for students
    // who pattern-match without reasoning.
    if (ALL_OR_NONE.test(optBody)) {
      return {
        ok: false,
        reason: 'all_or_none_option',
        detail: `item ${i} option "${optBody.slice(0, 40)}" is an all-of-the-above / none-of-the-above filler`,
      };
    }

    if (isCorrect) correctCount++;
    options.push({
      label: label || labelForIndex(j),
      body: optBody,
      isCorrect,
    });
  }

  // Exactly one correct.
  if (correctCount === 0) {
    return {
      ok: false,
      reason: 'no_correct',
      detail: `item ${i} has no option flagged isCorrect`,
    };
  }
  if (correctCount > 1) {
    return {
      ok: false,
      reason: 'multiple_correct',
      detail: `item ${i} has ${correctCount} options flagged isCorrect`,
    };
  }

  // If a free-form correct-answer field slipped in, it must agree
  // with the isCorrect option. Some models add `correctAnswer` /
  // `answer` / `correct_option` unprompted.
  const correctOption = options.find((o) => o.isCorrect)!;
  const wildcardCorrect = firstString(
    q.correctAnswer,
    q.answer,
    q.correct_option,
    q.correctOption,
  );
  if (wildcardCorrect !== undefined) {
    const nWild = wildcardCorrect.trim().toLowerCase();
    const nLabel = correctOption.label.toLowerCase();
    const nBody = correctOption.body.toLowerCase();
    // Accept either "B" or "B. Cell nucleus" or "Cell nucleus".
    const bodyContains = nBody.includes(nWild) || nWild.includes(nBody);
    if (nWild !== nLabel && !bodyContains) {
      return {
        ok: false,
        reason: 'correct_answer_field_mismatch',
        detail: `item ${i} correctAnswer="${wildcardCorrect}" doesn't match isCorrect option (${correctOption.label}: ${correctOption.body.slice(0, 40)})`,
      };
    }
  }

  // Stem-leaks-answer. If 4+ consecutive words of the correct
  // option appear in the stem, the question tests reading not
  // knowledge — the model wrapped the answer inside the prompt
  // and the distractors are cosmetic. Short options (< 4 words)
  // are exempt because a proper-noun answer like "Chad" can't
  // trigger this without also matching against the syllabus
  // context, which is a different failure.
  if (stemLeaksAnswer(body, correctOption.body)) {
    return {
      ok: false,
      reason: 'stem_leaks_answer',
      detail: `item ${i} stem contains the correct answer verbatim (4+ words match)`,
    };
  }

  // Option-length ratio — the well-known "correct is longest" LLM
  // tell. Warn-only (remediation 1.5: soft first, harden once the
  // reject log shows the rate).
  const lengths = options.map((o) => o.body.length);
  const ratio = Math.max(...lengths) / Math.max(1, Math.min(...lengths));
  if (ratio > OPTION_LENGTH_RATIO_WARN) {
    const longest = options.reduce((a, b) =>
      a.body.length >= b.body.length ? a : b,
    );
    warnings.push(
      `item ${i} option-length ratio ${ratio.toFixed(2)} exceeds ${OPTION_LENGTH_RATIO_WARN}${longest.isCorrect ? ' and the CORRECT option is the longest' : ''}`,
    );
  }

  // Difficulty: the admin's REQUEST is authoritative (remediation
  // 1.5) — the old code silently stored the model's self-grade,
  // letting the model rewrite the requested difficulty mix.
  const claimed =
    q.difficulty === 'easy' ||
    q.difficulty === 'medium' ||
    q.difficulty === 'hard'
      ? q.difficulty
      : undefined;
  let difficulty: 'easy' | 'medium' | 'hard';
  if (opts.requestedDifficulty) {
    difficulty = opts.requestedDifficulty;
    if (claimed && claimed !== opts.requestedDifficulty) {
      warnings.push(
        `item ${i} self-graded "${claimed}" but the batch requested "${opts.requestedDifficulty}" — stored as requested`,
      );
    }
  } else {
    difficulty = claimed ?? 'medium';
    if (!claimed)
      warnings.push(`item ${i} had no valid difficulty; defaulted to medium`);
  }

  const explanation = rawExplanation;

  // Per-question worked-example enforcement. Two paths trigger it:
  //   1) the whole batch was flagged quantitative by the caller
  //      (subject allowlist), or
  //   2) this individual question looks calc-shaped by content —
  //      calc keywords, LaTeX in stem, numeric options, unit hints.
  // The check only runs when there's an explanation to inspect —
  // if the caller opted out of explanations (`includeExplanations:
  // false`), the field is empty by design and nothing to enforce.
  if (explanation.trim()) {
    const isCalc =
      opts.requireWorkedExampleForBatch ||
      looksLikeCalcQuestion({ stem: body, options });
    if (
      isCalc &&
      !/^\s*#{1,6}\s+(?:Worked\s+Example|Example)\b/im.test(explanation)
    ) {
      return {
        ok: false,
        reason: 'missing_worked_example_calc',
        detail: `item ${i} looks calculation-shaped but its explanation has no \`## Worked Example\` section`,
      };
    }
  }

  return {
    ok: true,
    value: { body, difficulty, options, explanation, warnings },
  };
}

/**
 * Server-side answer-position shuffle (remediation 0.7). Fisher–Yates
 * over the options, then labels reassigned A–D in the new order. Runs
 * AFTER validation and BEFORE insert — deterministic balance instead
 * of begging the model (LLM C-bias is well documented). Explanations
 * are unaffected because the contract bans letter references.
 */
export function shuffleOptions(question: ParsedQuestion): ParsedQuestion {
  const shuffled = question.options.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return {
    ...question,
    options: shuffled.map((o, idx) => ({ ...o, label: labelForIndex(idx) })),
  };
}

function stripFences(s: string): string {
  const withoutOpen = s.replace(/^```(?:json)?\s*\n?/i, '');
  return withoutOpen.replace(/\n?```\s*$/i, '');
}

function isRefusalObject(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.error === 'string' && obj.error.length > 0;
}

function labelForIndex(i: number): string {
  return ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'][i] ?? String(i + 1);
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return undefined;
}

/**
 * Detects when a substantial chunk of the correct option text
 * appears verbatim in the stem. "4+ consecutive words match after
 * normalisation" is the threshold — chosen empirically to catch the
 * common LLM failure ("The mitochondria of the cell is the … " →
 * correct = "powerhouse of the cell") without false-positiving on
 * short one- or two-word answers where any overlap is coincidental.
 *
 * Normalisation: lowercase, strip punctuation, collapse whitespace.
 * Numeric/unit answers ("12 m/s") pass through as-is so an answer
 * whose ONLY tokens are numbers doesn't get flagged.
 */
export function stemLeaksAnswer(stem: string, answerBody: string): boolean {
  const answerTokens = tokenize(answerBody);
  if (answerTokens.length < 4) return false;
  const stemNorm = tokenize(stem).join(' ');
  // Slide a 4-token window through the answer and check each
  // window against the stem. 4 is deliberately conservative — 3 too
  // eagerly flags "the mass is 12 kilograms" against "12 kilograms
  // of iron" style patterns; 5 misses shorter leaks.
  for (let i = 0; i <= answerTokens.length - 4; i++) {
    const window = answerTokens.slice(i, i + 4).join(' ');
    if (stemNorm.includes(window)) return true;
  }
  return false;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}
