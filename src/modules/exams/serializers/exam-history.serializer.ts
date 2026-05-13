import { Exam } from '../entities/exam.entity';
import { Subject } from '../../subjects/entities/subject.entity';
import { ExamMode, ExamType } from '../../../common/types/enums';

/**
 * Compact row for the practice-history list. Includes everything the mobile
 * needs to render the row (subject names, score, date) so the screen can
 * paginate without a second round-trip per row.
 */
export interface ExamHistoryRow {
  examId: string;
  mode: ExamMode;
  examType: ExamType;
  subjects: Array<{ id: string; name: string }>;
  totalQuestions: number;
  correctCount: number;
  /** 0..100, rounded to 1 decimal — same convention as ExamResultResponse.percent. */
  percentScore: number;
  xpEarned: number;
  durationSeconds: number;
  completedAt: string;
}

export function toExamHistoryRow(
  exam: Exam,
  subjectIndex: Map<string, Subject>,
): ExamHistoryRow {
  const filter = (exam.subjectFilter ?? {}) as { subjectIds?: string[] };
  const subjectIds = Array.isArray(filter.subjectIds) ? filter.subjectIds : [];
  const subjects = subjectIds
    .map((id) => subjectIndex.get(id))
    .filter((s): s is Subject => Boolean(s))
    .map((s) => ({ id: s.id, name: s.name }));

  const total = exam.totalQuestions ?? 0;
  const correct = exam.score ?? 0;
  const percent = exam.percentScore != null ? Number(exam.percentScore) : 0;

  const startedMs = exam.startedAt?.getTime() ?? 0;
  const completedMs = exam.completedAt?.getTime() ?? startedMs;
  const durationSeconds = Math.max(
    0,
    Math.round((completedMs - startedMs) / 1000),
  );

  return {
    examId: exam.id,
    mode: exam.mode,
    examType: exam.examType,
    subjects,
    totalQuestions: total,
    correctCount: correct,
    percentScore: Number.isFinite(percent) ? percent : 0,
    xpEarned: exam.xpEarned ?? 0,
    durationSeconds,
    completedAt: (exam.completedAt ?? exam.startedAt).toISOString(),
  };
}
