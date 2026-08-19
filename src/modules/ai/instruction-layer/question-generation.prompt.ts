import { ExamType } from '../../../common/types/enums';
import { SYSTEM_SHELL_QUESTION_GENERATION } from './system-shell';

/**
 * Contract for the JSON the model MUST return. Kept as a single
 * literal in one place so this string, the validator (0.1d), and any
 * client-side parser stay in lock-step.
 */
export const QUESTION_GENERATION_SCHEMA = `[
  {
    "body": "<question stem>",
    "difficulty": "easy|medium|hard",
    "options": [
      { "label": "A", "body": "<option text>", "isCorrect": false },
      { "label": "B", "body": "<option text>", "isCorrect": true },
      { "label": "C", "body": "<option text>", "isCorrect": false },
      { "label": "D", "body": "<option text>", "isCorrect": false }
    ],
    "explanation": "<optional short rationale, may be empty string>"
  }
]`;

export interface ExemplarForPrompt {
  body: string;
  options: Array<{ label: string; body: string; isCorrect: boolean }>;
  explanation: string | null;
  year: number | null;
  paper: number | null;
  difficulty: string;
}

export interface QuestionGenerationPromptArgs {
  examType: ExamType;
  subjectName: string;
  /** For NOVDEC (no form level), pass null; the prompt drops the "Form N" line. */
  formLevel: number | null;
  difficulty: 'easy' | 'medium' | 'hard';
  count: number;
  /** Human-readable syllabus topic title ("Vectors and scalars"). */
  topicTitle: string;
  /**
   * Syllabus context for the topic — bullet list of learning
   * outcomes / indicators. Defines the SCOPE of the batch, not the
   * source material. Kept short and specific: 5–15 lines is typical.
   */
  syllabusContext: string;
  /**
   * Past-paper questions on the same subject (and preferably the
   * same syllabus topic + difficulty) — few-shot style references.
   * Empty array is allowed and just skips the exemplar block; the
   * grounding rules in the system shell still hold, the model just
   * has less signal about voice.
   */
  pastPaperExemplars: ExemplarForPrompt[];
  /** When true, the model includes a short rationale per question. */
  includeExplanations: boolean;
  /**
   * Quantitative subject flag — Physics, Chemistry, Mathematics,
   * Additional Mathematics, Statistics, Accounting, Economics, etc.
   * When true, every explanation MUST include both `## Solution` and
   * `## Worked Example` sections. Otherwise the worked example
   * is optional per the system shell's explanation rules.
   */
  isQuantitativeSubject: boolean;
}

export interface BuiltPrompt {
  system: string;
  user: string;
}

/**
 * Builds the (system, user) tuple for a question-generation call.
 * Pure function — no DB reads, no side effects, no NestJS decorators.
 * Provider-agnostic: BedrockClient and OllamaClient both consume the
 * exact same tuple.
 */
export function buildQuestionGenerationPrompt(
  args: QuestionGenerationPromptArgs,
): BuiltPrompt {
  const levelLine =
    args.formLevel != null
      ? `Level: Form ${args.formLevel}`
      : `Level: senior review (no form level — NOVDEC candidate)`;
  const explanationLine = args.includeExplanations
    ? args.isQuantitativeSubject
      ? '- Include an `explanation` per question following the explanation rules in the system turn. This is a QUANTITATIVE subject — every explanation MUST contain BOTH a `## Solution` section (step-by-step working with units) AND a `## Worked Example` section (a similar-but-different problem, worked step-by-step).\n'
      : '- Include an `explanation` per question following the explanation rules in the system turn.\n'
    : '- Set `explanation` to an empty string on every question.\n';

  const exemplarBlock = renderExemplarBlock(args.pastPaperExemplars);

  const user = `Exam: ${args.examType.toUpperCase()}
Subject: ${args.subjectName}
${levelLine}
Topic: ${args.topicTitle}
Difficulty: ${args.difficulty}
Count: ${args.count}
Quantitative subject: ${args.isQuantitativeSubject ? 'true' : 'false'}

Syllabus scope for this batch (topic areas to cover — this is
not the source material to quote):
${args.syllabusContext}
${exemplarBlock}
Task:
- Produce EXACTLY ${args.count} new multiple-choice questions on
  the topic scope above.
- Every question is a 4-option MCQ with labels A, B, C, D.
- Exactly one option per question is correct.
- Distribute the correct answers roughly evenly across A / B / C / D
  across the batch (do not put the correct answer at the same
  position every time).
- Vary the stem shape across the batch: mix short factual recall
  with applied / calculation / comparison stems so the batch
  doesn't read as ${args.count} of the same question type.
${explanationLine}
Return a JSON array matching this exact schema. No prose outside
the JSON:
${QUESTION_GENERATION_SCHEMA}`;

  return {
    system: SYSTEM_SHELL_QUESTION_GENERATION,
    user,
  };
}

/**
 * Render the past-paper exemplar block. Empty array collapses to an
 * empty string so we don't inject noise when there's nothing on the
 * shelf.
 *
 * The framing at the top of the block is deliberately blunt: the
 * exemplars are for STYLE only — the model must not copy facts, and
 * must not narrow onto whatever sub-topic the exemplars happen to
 * bunch on. This is where the "3 examples all happen to be about
 * quadratic equations even though the topic is 'polynomials'" trap
 * gets called out inline.
 */
function renderExemplarBlock(exemplars: ExemplarForPrompt[]): string {
  if (!exemplars.length) return '';
  const rendered = exemplars
    .map((e, i) => renderExemplar(e, i + 1))
    .join('\n\n');
  return `\nPast-paper reference questions on this subject/topic
(these are STYLE MODELS — mirror the register, stem length,
distractor plausibility, and explanation voice. Do NOT copy any
facts, dates, names, or figures verbatim. Do NOT narrow the batch
to only the sub-topics represented here — cover the full syllabus
scope above):
${rendered}
`;
}

function renderExemplar(e: ExemplarForPrompt, n: number): string {
  const provenance = [
    e.year ? String(e.year) : null,
    e.paper ? `Paper ${e.paper}` : null,
    `[${e.difficulty}]`,
  ]
    .filter(Boolean)
    .join(' · ');
  const opts = e.options
    .map((o) => `${o.label}. ${o.body}${o.isCorrect ? '  ← correct' : ''}`)
    .join('\n');
  const explanation = (e.explanation ?? '').trim();
  const explanationBlock = explanation ? `\nExplanation: ${explanation}` : '';
  return `Example ${n} — ${provenance}
Q: ${e.body}
${opts}${explanationBlock}`;
}
