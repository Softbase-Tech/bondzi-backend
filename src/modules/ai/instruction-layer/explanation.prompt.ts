import { ExamType } from '../../../common/types/enums';
import { SYSTEM_SHELL_EXPLANATION } from './system-shell';
import type { BuiltPrompt } from './question-generation.prompt';

/**
 * Version tag recorded on ai_usage_log.prompt_version for standalone
 * explanation calls. Bump on material contract changes.
 */
export const EXPLANATION_PROMPT_VERSION = 'expl-v2';

/**
 * Output contract for explanation generation. Plain markdown, not
 * JSON — the mobile explanation surface already renders markdown
 * (KaTeX/MathJax pipeline) and wrapping in JSON would add a
 * pointless parse step. The validator (0.1d) checks the shape
 * against these rules directly.
 *
 * Remediation 0.8: the correct answer is stated by QUOTING its option
 * text, never by letter — server-side option shuffling makes letter
 * references go stale.
 */
export const EXPLANATION_OUTPUT_CONTRACT = `Output plain markdown.

REQUIRED section:
  \`## Solution\`
     Explain why the correct option is right. Identify the concept, then
     reason it through — for a calculation, show the derivation step by
     step with units on every numeric intermediate; for a conceptual or
     recall question, explain the underlying idea plainly. State the
     correct answer by QUOTING the correct option's text exactly, e.g.
     "The correct answer is **48 m/s**." — never by letter ("option B"
     is banned; option order is shuffled after generation). Then, in one
     line each, say why the other options are wrong — quote each wrong
     option's text and name the common misconception behind it.

OPTIONAL section:
  \`## Worked Example\`
     Include this section ONLY when a second, fresh worked example
     genuinely deepens understanding — i.e. computational / procedural
     questions where practising the method on DIFFERENT numbers or a
     different framing helps. Show its full derivation.
     DO NOT include this section for definition, recall, or purely
     conceptual questions where a second example would just repeat the
     solution. When you omit it, do not leave an empty heading — omit
     the heading entirely.

Length:
  - Solution-only (no worked example): keep it tight — up to ~400 words.
  - With a worked example: ~250-600 words total. Do not pad.

The two sections must NOT repeat each other: the worked example is a
NEW problem, never a restatement of the solution.

Do not include:
  - Preamble ("Great question!", "Let's dive in!")
  - Closing pleasantries ("Hope that helps!")
  - Any reference to the exam board or "the syllabus"
  - References to options by letter ("option A", "the answer is C")
  - Emoji, or headings other than \`## Solution\` and \`## Worked Example\``;

export interface ExplanationPromptArgs {
  examType: ExamType;
  subjectName: string;
  /** For NOVDEC (no form level), pass null and the prompt says "senior review". */
  formLevel: number | null;
  /** The question stem to explain. */
  questionBody: string;
  /**
   * Every option in original label order (A, B, C, D). The correct
   * one is identified by `correctLabel`.
   */
  options: Array<{ label: string; body: string }>;
  correctLabel: string;
  /**
   * Optional syllabus context — same content as the question was
   * generated against. Explanations for past-paper questions
   * (imported before syllabus mapping) may pass an empty string;
   * the model then grounds on the question stem alone.
   */
  syllabusContext?: string;
  /**
   * Optional retrieved learning-material block (Knowledge Layer).
   * When present it is injected as <data type="reference_material">
   * and the shell instructs the model to treat it as the primary
   * fact source.
   */
  referenceMaterial?: string;
  /**
   * Quantitative subject flag — Physics, Chemistry, Mathematics,
   * Additional Mathematics, Statistics, Accounting, Economics, etc.
   * When true, the explanation MUST contain both `## Solution` and
   * `## Worked Example`. Otherwise the worked example is optional.
   */
  isQuantitativeSubject?: boolean;
  /**
   * DB-served system shell (remediation 1.2): when
   * AI_PROMPT_TEMPLATES_ENABLED is on, the caller passes the active
   * EXPLANATION template's content here and the compiled shell is
   * bypassed. The {examType}/{formLevel} tokens are interpolated on
   * whichever shell is used. Undefined → compiled shell (default).
   */
  systemShellOverride?: string;
}

export function buildExplanationPrompt(
  args: ExplanationPromptArgs,
): BuiltPrompt {
  const levelLabel =
    args.formLevel != null
      ? `Form ${args.formLevel}`
      : 'senior review (no form level — NOVDEC candidate)';
  // The shell has {examType} / {formLevel} tokens — swap them in so
  // the "student level" instruction reads correctly at inference.
  const system = (args.systemShellOverride?.trim() || SYSTEM_SHELL_EXPLANATION)
    .replace(/\{examType\}/g, args.examType.toUpperCase())
    .replace(
      /\{formLevel\}/g,
      args.formLevel != null ? String(args.formLevel) : '3',
    );

  const sortedOptions = args.options
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label));
  const optionsBlock = sortedOptions
    .map((o) => `${o.label}. ${o.body}`)
    .join('\n');

  // Remediation 0.8 / codex finding: hand the model the correct
  // option's TEXT, not just its letter — and require the explanation
  // to quote the text. The letter is still supplied so the model can
  // locate the option in the list.
  const correctOption = sortedOptions.find(
    (o) => o.label.toUpperCase() === args.correctLabel.toUpperCase(),
  );
  const correctLine = correctOption
    ? `Provided correct answer: "${correctOption.body}" (listed as option ${correctOption.label})`
    : `Provided correct answer: option ${args.correctLabel}`;

  // Remediation 0.2: the syllabus context is SCOPE, not source — the
  // old wording here ("ground on this ONLY — no outside knowledge")
  // contradicted the system shell and starved explanations of real
  // facts. Remediation 1.8: wrapped as <data>.
  const contextBlock = args.syllabusContext?.trim()
    ? `Syllabus context (the learning outcome this question serves —
scope only, never quote its wording):
<data type="syllabus_context">
${args.syllabusContext}
</data>

`
    : '';

  const referenceBlock = args.referenceMaterial?.trim()
    ? `Reference material (PRIMARY fact source — formulae, definitions
and methods must agree with this exactly):
<data type="reference_material">
${args.referenceMaterial}
</data>

`
    : '';

  const user = `Exam: ${args.examType.toUpperCase()}
Subject: ${args.subjectName}
Student level: ${levelLabel}
Quantitative subject: ${args.isQuantitativeSubject ? 'true' : 'false'}

${contextBlock}${referenceBlock}Question:
<data type="question">
${args.questionBody}
</data>

Options:
<data type="options">
${optionsBlock}
</data>

${correctLine}

Remember: solve the question independently FIRST. If your answer
disagrees with the provided correct answer, return the key_mismatch
refusal instead of an explanation.

${EXPLANATION_OUTPUT_CONTRACT}`;

  return { system, user };
}
