import { ExamType } from '../../../common/types/enums';
import { SYSTEM_SHELL_EXPLANATION } from './system-shell';
import type { BuiltPrompt } from './question-generation.prompt';

/**
 * Output contract for explanation generation. Plain markdown, not
 * JSON — the mobile explanation surface already renders markdown
 * (KaTeX/MathJax pipeline) and wrapping in JSON would add a
 * pointless parse step. The validator (0.1d) checks the shape
 * against these rules directly.
 */
export const EXPLANATION_OUTPUT_CONTRACT = `Output plain markdown.

REQUIRED section:
  \`## Solution\`
     Explain why the correct option is right. Identify the concept, then
     reason it through — for a calculation, show the derivation step by
     step with units on every numeric intermediate; for a conceptual or
     recall question, explain the underlying idea plainly. State the
     correct option (e.g. "The correct answer is B.") and, in one line
     each, why the other options are wrong (name the common misconception
     behind each distractor).

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
  const system = SYSTEM_SHELL_EXPLANATION.replace(
    /\{examType\}/g,
    args.examType.toUpperCase(),
  ).replace(
    /\{formLevel\}/g,
    args.formLevel != null ? String(args.formLevel) : '3',
  );

  const optionsBlock = args.options
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((o) => `${o.label}. ${o.body}`)
    .join('\n');

  const contextBlock = args.syllabusContext?.trim()
    ? `Syllabus context (ground on this ONLY — no outside knowledge):
${args.syllabusContext}

`
    : '';

  const user = `Exam: ${args.examType.toUpperCase()}
Subject: ${args.subjectName}
Student level: ${levelLabel}

${contextBlock}Question:
${args.questionBody}

Options:
${optionsBlock}

Correct answer: ${args.correctLabel}

${EXPLANATION_OUTPUT_CONTRACT}`;

  return { system, user };
}
