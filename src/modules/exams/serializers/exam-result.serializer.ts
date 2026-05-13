import { Exam } from '../entities/exam.entity';
import { ExamAnswer } from '../entities/exam-answer.entity';
import { Topic } from '../../subjects/entities/topic.entity';
import { inlineMathInMarkdown } from '../../../common/utils/math.util';

/**
 * Shape returned by GET /exams/:id/result. Matches the mobile Zod
 * `ExamResultSchema` — produce everything the UI consumes, including empty
 * arrays (never `undefined`) so downstream `.length` never crashes.
 *
 * `score` is a 0..1 ratio (the UI multiplies by 100 for display).
 * `xpEarned` is a thin first cut: 10 XP per correct answer. Tune later.
 */
export interface ExamResultResponse {
  examId: string;
  score: number;
  grade: string;
  totalQuestions: number;
  correctCount: number;
  wrongCount: number;
  skippedCount: number;
  xpEarned: number;
  durationSeconds: number;
  streakMaintained: boolean;
  byTopic: Array<{
    topicId: string;
    topicName: string;
    accuracy: number;
    correctCount: number;
    totalCount: number;
  }>;
  wrongAnswers: Array<{
    questionId: string;
    questionText: string;
    yourAnswer: string | null;
    correctAnswer: string;
  }>;
}

function deriveGrade(percent: number): string {
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

export function toExamResultResponse(
  exam: Exam,
  answers: ExamAnswer[],
  topics: Topic[],
): ExamResultResponse {
  const topicName = new Map(topics.map((t) => [t.id, t.title] as const));

  const totalQuestions = exam.questionIds.length;
  const correctCount = answers.filter((a) => a.isCorrect).length;
  const wrongCount = answers.filter((a) => a.isCorrect === false).length;
  const skippedCount = Math.max(0, totalQuestions - answers.length);

  const scoreRatio = totalQuestions > 0 ? correctCount / totalQuestions : 0;
  const percent = scoreRatio * 100;

  // Per-topic accuracy aggregation.
  const byTopicMap = new Map<string, { correct: number; total: number }>();
  for (const a of answers) {
    const tid = a.question?.topicId ?? '_none';
    const slot = byTopicMap.get(tid) ?? { correct: 0, total: 0 };
    slot.total += 1;
    if (a.isCorrect) slot.correct += 1;
    byTopicMap.set(tid, slot);
  }

  const byTopic = Array.from(byTopicMap.entries())
    .filter(([tid]) => tid !== '_none')
    .map(([tid, s]) => ({
      topicId: tid,
      topicName: topicName.get(tid) ?? 'Other',
      accuracy: s.total > 0 ? s.correct / s.total : 0,
      correctCount: s.correct,
      totalCount: s.total,
    }));

  const wrongAnswers = answers
    .filter((a) => a.isCorrect === false)
    .map((a) => {
      const correct = a.question?.options?.find((o) => o.isCorrect);
      const selected = a.question?.options?.find(
        (o) => o.id === a.selectedOptionId,
      );
      // The mobile review card needs the same SVG-data-URI math the live
      // exam screen renders — without this, raw `$2^{2}\times 3$` LaTeX
      // leaks into the UI as plain text. Same util the question
      // serializer uses, so the rendered output is identical.
      const rawAnswer = selected?.body ?? a.typedAnswer ?? null;
      return {
        questionId: a.questionId,
        questionText: inlineMathInMarkdown(a.question?.body ?? ''),
        yourAnswer: rawAnswer !== null ? inlineMathInMarkdown(rawAnswer) : null,
        correctAnswer: inlineMathInMarkdown(correct?.body ?? ''),
      };
    });

  const durationSeconds =
    exam.completedAt && exam.startedAt
      ? Math.max(
          0,
          Math.round(
            (exam.completedAt.getTime() - exam.startedAt.getTime()) / 1000,
          ),
        )
      : 0;

  return {
    examId: exam.id,
    score: scoreRatio,
    grade: deriveGrade(percent),
    totalQuestions,
    correctCount,
    wrongCount,
    skippedCount,
    xpEarned: correctCount * 10,
    durationSeconds,
    streakMaintained: true,
    byTopic,
    wrongAnswers,
  };
}
