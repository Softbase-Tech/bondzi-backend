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
   * Full syllabus context for the topic — bullet-list of sub-topics /
   * outcomes / knowledge points. This is the ONLY thing the model is
   * allowed to ground on (per system-shell grounding rules). Keep it
   * short and specific: 5-15 lines is typical.
   */
  syllabusContext: string;
  /** When true, the model includes a short rationale per question. */
  includeExplanations: boolean;
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
    ? '- Include a concise `explanation` per question (2-3 sentences).\n'
    : '- Set `explanation` to an empty string on every question.\n';

  const user = `Exam: ${args.examType.toUpperCase()}
Subject: ${args.subjectName}
${levelLine}
Topic: ${args.topicTitle}
Difficulty: ${args.difficulty}
Count: ${args.count}

Syllabus context (ground on this ONLY — no outside knowledge):
${args.syllabusContext}

Task:
- Produce EXACTLY ${args.count} multiple-choice questions on the topic above.
- Every question is a 4-option MCQ with labels A, B, C, D.
- Exactly one option per question is correct.
${explanationLine}
Return a JSON array matching this exact schema. No prose outside the JSON:
${QUESTION_GENERATION_SCHEMA}`;

  return {
    system: SYSTEM_SHELL_QUESTION_GENERATION,
    user,
  };
}
