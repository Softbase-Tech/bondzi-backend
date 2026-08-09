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
 * Five rules per question:
 *   (a) exactly one option is flagged `isCorrect: true`
 *   (b) stem (`body`) is non-empty after trim
 *   (c) every option body is non-empty after trim
 *   (d) no duplicate option text (weaker models produce dupes)
 *   (e) if the model added a free-form correct-answer field
 *       (`correctAnswer` / `answer` / `correct_option`), its content
 *       matches either the `label` or the `body` of the isCorrect
 *       option (weaker models occasionally write these fields
 *       independently of the isCorrect flag and disagree with
 *       themselves)
 *
 * No second-pass LLM verification — you asked to hold that until
 * the reject log shows enough BAD keys (not just bad structure) to
 * justify doubling generation cost. When we get there, the second
 * pass slots in AFTER these rule checks and BEFORE the DB insert.
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
  | 'model_refused';

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

/** How many options we expect. WAEC MCQ is always 4. */
const EXPECTED_OPTION_COUNT = 4;

/**
 * Validates a raw model output string as a batch of MCQ questions.
 * Parses JSON, then applies the five rules above. Returns
 * `{ ok: true, value }` with a typed array on success, or
 * `{ ok: false, reason, detail, failedIndex? }` on failure — never
 * throws.
 */
export function validateQuestionBatch(
  rawText: string,
): QuestionValidationResult {
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
  // return {"error":"out_of_syllabus", "detail":"..."} when the topic
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

  const out: ParsedQuestion[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const q = parsed[i] as Record<string, unknown>;
    if (!q || typeof q !== 'object') {
      return {
        ok: false,
        reason: 'schema_invalid',
        detail: `item ${i} is not an object`,
        failedIndex: i,
      };
    }
    const body = typeof q.body === 'string' ? q.body.trim() : '';
    if (!body) {
      return {
        ok: false,
        reason: 'empty_stem',
        detail: `item ${i} has empty body`,
        failedIndex: i,
      };
    }
    const rawOptions = q.options;
    if (!Array.isArray(rawOptions)) {
      return {
        ok: false,
        reason: 'no_options',
        detail: `item ${i} missing options array`,
        failedIndex: i,
      };
    }
    if (rawOptions.length !== EXPECTED_OPTION_COUNT) {
      return {
        ok: false,
        reason: 'wrong_option_count',
        detail: `item ${i} has ${rawOptions.length} options; expected ${EXPECTED_OPTION_COUNT}`,
        failedIndex: i,
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
          failedIndex: i,
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
          failedIndex: i,
        };
      }
      // Rule (d) — duplicate option text. Case-insensitive because
      // "Water" vs "water" is still a dupe from the student's POV.
      const key = optBody.toLowerCase();
      if (seenTexts.has(key)) {
        return {
          ok: false,
          reason: 'duplicate_option_text',
          detail: `item ${i} has duplicate option text: "${optBody.slice(0, 60)}"`,
          failedIndex: i,
        };
      }
      seenTexts.add(key);
      if (isCorrect) correctCount++;
      options.push({
        label: label || labelForIndex(j),
        body: optBody,
        isCorrect,
      });
    }

    // Rule (a) — exactly one correct.
    if (correctCount === 0) {
      return {
        ok: false,
        reason: 'no_correct',
        detail: `item ${i} has no option flagged isCorrect`,
        failedIndex: i,
      };
    }
    if (correctCount > 1) {
      return {
        ok: false,
        reason: 'multiple_correct',
        detail: `item ${i} has ${correctCount} options flagged isCorrect`,
        failedIndex: i,
      };
    }

    // Rule (e) — if a free-form correct-answer field slipped in,
    // it must agree with the isCorrect option. Some models add
    // `correctAnswer` / `answer` / `correct_option` unprompted.
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
          failedIndex: i,
        };
      }
    }

    const difficulty =
      q.difficulty === 'easy' ||
      q.difficulty === 'medium' ||
      q.difficulty === 'hard'
        ? q.difficulty
        : 'medium';
    const explanation = typeof q.explanation === 'string' ? q.explanation : '';

    out.push({ body, difficulty, options, explanation });
  }

  return { ok: true, value: out };
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
