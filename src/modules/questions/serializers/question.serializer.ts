import { Option } from '../entities/option.entity';
import { Question } from '../entities/question.entity';
import { QuestionStimulus } from '../entities/question-stimulus.entity';
import {
  Difficulty,
  ExamType,
  QuestionSource,
  QuestionStatus,
  QuestionType,
} from '../../../common/types/enums';
import { inlineMathInMarkdown } from '../../../common/utils/math.util';

/**
 * Student-facing shape — matches the mobile Zod schema exactly
 * (see mobile/lib/validators/index.ts `QuestionSchema`). Field names
 * deliberately differ from the DB entity to decouple API from storage.
 */
export interface StudentOption {
  id: string;
  label: string;
  text: string;
  imageUrl: string | null;
}

export type MobileQuestionType = 'mcq' | 'short_answer' | 'true_false';

export interface StudentStimulus {
  id: string;
  /** Markdown with `$...$` math already inlined as SVG data URIs. */
  text: string;
  imageUrl: string | null;
}

export interface StudentQuestion {
  id: string;
  subjectId: string;
  topicId: string | null;
  /**
   * FK to a shared stimulus block. Mobile groups consecutive questions
   * sharing the same `stimulusId` into a single screen with the stimulus
   * pinned at the top.
   */
  stimulusId: string | null;
  /**
   * Inlined stimulus payload — present iff `stimulusId` is non-null. Each
   * question in a group repeats this so the mobile can render groups
   * lazily without a second fetch.
   */
  stimulus: StudentStimulus | null;
  text: string;
  type: MobileQuestionType;
  options: StudentOption[];
  correctAnswer: string | null;
  difficulty: string;
  year: number | null;
  paper: string | null;
  source: string | null;
  isVerified: boolean;
  imageUrl: string | null;
  /**
   * v2: true when the question has an inline AI explanation stored.
   * The `explanation` field itself is only populated for subscribed users.
   * Free users see the lock badge and are nudged to upgrade.
   */
  hasExplanation: boolean;
  explanation: string | null;
  explanationHtml: string | null;
}

function mapQuestionType(t: QuestionType): MobileQuestionType {
  // Only MCQ and true/false render natively; everything else degrades to a
  // text field on the client. Keep the backend enum richer for grading.
  if (t === QuestionType.TRUE_FALSE) return 'true_false';
  if (t === QuestionType.MCQ) return 'mcq';
  return 'short_answer';
}

/**
 * [SEC] Single choke point that converts a Question -> the shape returned to
 * students. `isCorrect` must NEVER leave this module in any student response.
 *
 * The `text` field is the markdown the mobile renderer consumes. Any `$...$`
 * math in the source body is replaced here with inline SVG data URIs so
 * react-native-markdown-display can show it via its image rule (mobile has
 * no LaTeX engine on-device — see mobile/components/exam/QuestionCard.tsx).
 * Output is memoised by the math util's LRU keyed on the LaTeX source.
 */
export function toStudentOption(o: Option): StudentOption {
  return {
    id: o.id,
    label: o.label,
    text: inlineMathInMarkdown(o.body),
    imageUrl: o.imageUrl,
  };
}

export interface StudentQuestionOptions {
  /** Has the caller an active subscription? Controls inline explanation visibility. */
  hasActiveSubscription?: boolean;
}

/**
 * Admin-facing shape. Includes `isCorrect` on each option (which the global
 * ClassSerializerInterceptor strips from class instances via @Exclude). We
 * return a plain-object tree so nothing in the response gets re-transformed
 * by the interceptor — admins need to see the correct answer to grade and
 * verify questions.
 */
export interface AdminOption {
  id: string;
  questionId: string;
  label: string;
  body: string;
  bodyHtml: string | null;
  imageUrl: string | null;
  isCorrect: boolean;
  sortOrder: number;
}

export interface AdminStimulus {
  id: string;
  title: string | null;
  body: string;
  bodyHtml: string | null;
  imageUrl: string | null;
}

export interface AdminQuestion {
  id: string;
  subjectId: string;
  topicId: string | null;
  stimulusId: string | null;
  stimulus: AdminStimulus | null;
  examType: ExamType;
  questionType: QuestionType;
  source: QuestionSource;
  body: string;
  bodyHtml: string | null;
  imageUrl: string | null;
  year: number | null;
  wassecPaper: number | null;
  section: string | null;
  difficulty: Difficulty;
  tags: string[];
  status: QuestionStatus;
  isVerified: boolean;
  flagCount: number;
  timesAnswered: number;
  timesCorrect: number;
  explanation: string | null;
  explanationHtml: string | null;
  explanationModel: string | null;
  explanationGeneratedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  options: AdminOption[];
  subject?: { id: string; code: string; name: string } | null;
  topic?: { id: string; title: string } | null;
}

function toAdminOption(o: Option): AdminOption {
  return {
    id: o.id,
    questionId: o.questionId,
    label: o.label,
    body: o.body,
    bodyHtml: o.bodyHtml,
    imageUrl: o.imageUrl,
    isCorrect: o.isCorrect,
    sortOrder: o.sortOrder,
  };
}

function toAdminStimulus(s: QuestionStimulus): AdminStimulus {
  return {
    id: s.id,
    title: s.title,
    body: s.body,
    bodyHtml: s.bodyHtml,
    imageUrl: s.imageUrl,
  };
}

function toStudentStimulus(s: QuestionStimulus): StudentStimulus {
  return {
    id: s.id,
    // Same math-inlining pipeline as the question body — the mobile reads
    // a single markdown blob and never runs LaTeX on-device.
    text: inlineMathInMarkdown(s.body),
    imageUrl: s.imageUrl,
  };
}

export function toAdminQuestion(q: Question): AdminQuestion {
  return {
    id: q.id,
    subjectId: q.subjectId,
    topicId: q.topicId,
    stimulusId: q.stimulusId,
    stimulus: q.stimulus ? toAdminStimulus(q.stimulus) : null,
    examType: q.examType,
    questionType: q.questionType,
    source: q.source,
    body: q.body,
    bodyHtml: q.bodyHtml,
    imageUrl: q.imageUrl,
    year: q.year,
    wassecPaper: q.wassecPaper,
    section: q.section,
    difficulty: q.difficulty,
    tags: q.tags,
    status: q.status,
    isVerified: q.isVerified,
    flagCount: q.flagCount,
    timesAnswered: q.timesAnswered,
    timesCorrect: q.timesCorrect,
    explanation: q.explanation,
    explanationHtml: q.explanationHtml,
    explanationModel: q.explanationModel,
    explanationGeneratedAt: q.explanationGeneratedAt,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
    options: (q.options ?? [])
      .slice()
      .sort(
        (a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label),
      )
      .map(toAdminOption),
    subject: q.subject
      ? { id: q.subject.id, code: q.subject.code, name: q.subject.name }
      : null,
    topic: q.topic ? { id: q.topic.id, title: q.topic.title } : null,
  };
}

export function toStudentQuestion(
  q: Question,
  opts: StudentQuestionOptions = {},
): StudentQuestion {
  const hasExplanation = Boolean(q.explanation);
  const includeExplanation = hasExplanation && opts.hasActiveSubscription;
  return {
    id: q.id,
    subjectId: q.subjectId,
    topicId: q.topicId,
    stimulusId: q.stimulusId,
    stimulus: q.stimulus ? toStudentStimulus(q.stimulus) : null,
    text: inlineMathInMarkdown(q.body),
    type: mapQuestionType(q.questionType),
    options: (q.options ?? [])
      .slice()
      .sort(
        (a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label),
      )
      .map(toStudentOption),
    correctAnswer: null,
    difficulty: q.difficulty,
    year: q.year,
    paper: q.wassecPaper ? `Paper ${q.wassecPaper}` : null,
    source: q.source,
    isVerified: q.isVerified,
    imageUrl: q.imageUrl,
    hasExplanation,
    // Inline math in the explanation too — Claude is prompted to emit
    // `$...$` LaTeX, so the same SVG-data-URI treatment applies.
    explanation:
      includeExplanation && q.explanation
        ? inlineMathInMarkdown(q.explanation)
        : null,
    explanationHtml: includeExplanation ? q.explanationHtml : null,
  };
}
