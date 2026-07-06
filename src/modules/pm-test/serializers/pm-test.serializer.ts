import { PmTestOption } from '../entities/pm-test-option.entity';
import { PmTestQuestion } from '../entities/pm-test-question.entity';
import { inlineMathInMarkdown } from '../../../common/utils/math.util';
import {
  StudentOption,
  StudentQuestion,
} from '../../questions/serializers/question.serializer';
import { QuestionType, QuestionStatus } from '../../../common/types/enums';

/**
 * Student-facing shape for a PM Test MCQ. `isCorrect` is stripped at this
 * single choke point so the pre-answer client never sees the answer key.
 * The `explanation` field IS included (PM Test content is gated by
 * subscription at the route level via `@RequiresSubscription()`).
 *
 * `text` fields run through inlineMathInMarkdown so any `$...$` LaTeX is
 * pre-rendered to inline SVG before mobile sees it (see
 * common/utils/math.util.ts).
 */
export interface StudentPmTestOption {
  id: string;
  label: string;
  text: string;
}

export interface StudentPmTestQuestion {
  id: string;
  subjectId: string;
  syllabusTopicId: string | null;
  formLevel: number;
  examType: string;
  text: string;
  options: StudentPmTestOption[];
  difficulty: string;
  explanation: string | null;
}

function toOption(o: PmTestOption): StudentPmTestOption {
  return { id: o.id, label: o.label, text: inlineMathInMarkdown(o.body) };
}

export function toStudentPmTestQuestion(
  q: PmTestQuestion,
): StudentPmTestQuestion {
  return {
    id: q.id,
    subjectId: q.subjectId,
    syllabusTopicId: q.syllabusTopicId,
    formLevel: q.formLevel,
    examType: q.examType,
    text: inlineMathInMarkdown(q.body),
    options: (q.options ?? [])
      .slice()
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(toOption),
    difficulty: q.difficulty,
    explanation: q.explanation ? inlineMathInMarkdown(q.explanation) : null,
  };
}

function toStudentOptionFromPmTest(o: PmTestOption): StudentOption {
  return {
    id: o.id,
    label: o.label,
    text: inlineMathInMarkdown(o.body),
    imageUrl: null,
  };
}

/**
 * Reshape a `PmTestQuestion` into the `StudentQuestion` wire shape the exam
 * session response emits. The mobile client currently reads exam-session
 * questions through a single Zod schema; giving pm_test-mode sessions the same
 * shape (with year/paper/stimulus nulled out) means the exam runner doesn't
 * need to know whether it's serving past-paper or AI-generated questions.
 *
 * `explanation` is only surfaced when `opts.hasActiveSubscription`; free users
 * see the lock badge — this mirrors `toStudentQuestion` for past papers.
 */
export function toStudentQuestionFromPmTest(
  q: PmTestQuestion,
  opts: { hasActiveSubscription: boolean } = { hasActiveSubscription: false },
): StudentQuestion {
  const hasExplanation = Boolean(q.explanation);
  const includeExplanation = hasExplanation && opts.hasActiveSubscription;
  const type: StudentQuestion['type'] =
    q.questionType === QuestionType.TRUE_FALSE
      ? 'true_false'
      : q.questionType === QuestionType.MCQ
        ? 'mcq'
        : 'short_answer';
  return {
    id: q.id,
    subjectId: q.subjectId,
    // PM-test questions link to syllabus_topic_id, not the past-paper topic id;
    // mobile treats `topicId: null` as "topic unknown from this source" and
    // the exam grouping code already handles that.
    topicId: null,
    stimulusId: null,
    stimulus: null,
    text: inlineMathInMarkdown(q.body),
    type,
    options: (q.options ?? [])
      .slice()
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(toStudentOptionFromPmTest),
    correctAnswer: null,
    difficulty: q.difficulty,
    year: null,
    paper: null,
    source: 'ai_pm_test',
    // status='active' means it survived admin review; treat that as verified
    // for the mobile "verified badge".
    isVerified: q.status === QuestionStatus.ACTIVE,
    imageUrl: null,
    hasExplanation,
    explanation:
      includeExplanation && q.explanation
        ? inlineMathInMarkdown(q.explanation)
        : null,
    explanationHtml: null,
  };
}
