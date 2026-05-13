import { Exam } from '../entities/exam.entity';
import { ExamStatus } from '../../../common/types/enums';
import {
  StudentQuestion,
  toStudentQuestion,
} from '../../questions/serializers/question.serializer';
import { Question } from '../../questions/entities/question.entity';

/**
 * Wire shape the mobile app expects for an exam session
 * (see mobile/lib/validators/index.ts `ExamSessionSchema`). Flat — no nested
 * `exam` / `questions` envelope — because that's what consumers already parse.
 *
 * `grade` is derived once the exam is completed: WASSCE-style letters
 * (A1–F9) based on the percent score. Left null until completion so the
 * exam screen doesn't prematurely display one.
 */
export interface ExamSessionResponse {
  id: string;
  userId: string;
  mode: string;
  questionCount: number;
  durationSeconds: number | null;
  startedAt: string;
  completedAt: string | null;
  abandonedAt: string | null;
  score: number | null;
  grade: string | null;
  questions: StudentQuestion[];
  subjectIds: string[];
}

function deriveGrade(percent: number | null): string | null {
  if (percent === null) return null;
  if (percent >= 75) return 'A1';
  if (percent >= 70) return 'B2';
  if (percent >= 65) return 'B3';
  if (percent >= 60) return 'C4';
  if (percent >= 55) return 'C5';
  if (percent >= 50) return 'C6';
  if (percent >= 45) return 'D7';
  if (percent >= 40) return 'E8';
  return 'F9';
}

export function toExamSessionResponse(
  exam: Exam,
  questions: Question[],
  opts: { hasActiveSubscription: boolean } = { hasActiveSubscription: false },
): ExamSessionResponse {
  const percent =
    exam.percentScore !== null && exam.percentScore !== undefined
      ? parseFloat(exam.percentScore)
      : null;

  const filter = (exam.subjectFilter ?? {}) as {
    subjectIds?: string[];
  };

  return {
    id: exam.id,
    userId: exam.userId,
    mode: exam.mode,
    questionCount: exam.totalQuestions ?? questions.length,
    durationSeconds: exam.durationSeconds,
    startedAt: exam.startedAt.toISOString(),
    completedAt: exam.completedAt ? exam.completedAt.toISOString() : null,
    // Abandoned exams record completedAt when the user gave up — surface that
    // separately so the UI can distinguish "done" from "bailed".
    abandonedAt:
      exam.status === ExamStatus.ABANDONED && exam.completedAt
        ? exam.completedAt.toISOString()
        : null,
    score: exam.score,
    grade: exam.status === ExamStatus.COMPLETED ? deriveGrade(percent) : null,
    questions: questions.map((q) => toStudentQuestion(q, opts)),
    subjectIds: Array.isArray(filter.subjectIds) ? filter.subjectIds : [],
  };
}
