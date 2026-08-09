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
export const EXPLANATION_OUTPUT_CONTRACT = `Output plain markdown with these sections in order:
  1. \`## Solution\`
     Full worked solution. Identify the concept, then show the
     derivation step by step. Use units on every numeric intermediate.
     State the correct option (e.g. "The correct answer is B.") and,
     in one line each, why A / C / D are wrong (name the common
     misconception behind each distractor).
  2. \`## Example\`
     A DIFFERENT worked example applying the same concept — different
     numbers or a different framing. Show its full derivation too.

Length target: 250-600 words. Under 250 usually means the worked
example is missing; over 600 usually means padding.

Do not include:
  - Preamble ("Great question!", "Let's dive in!")
  - Closing pleasantries ("Hope that helps!")
  - Any reference to the exam board or "the syllabus"
  - Emoji, or headings other than \`## Solution\` and \`## Example\``;

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
