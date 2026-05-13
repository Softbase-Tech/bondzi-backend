import { PmTestOption } from '../entities/pm-test-option.entity';
import { PmTestQuestion } from '../entities/pm-test-question.entity';
import { inlineMathInMarkdown } from '../../../common/utils/math.util';

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
