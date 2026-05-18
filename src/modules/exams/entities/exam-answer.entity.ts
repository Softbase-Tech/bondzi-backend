import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Exam } from './exam.entity';
import { Question } from '../../questions/entities/question.entity';
import { Option } from '../../questions/entities/option.entity';
import { QuestionPool } from '../../../common/types/enums';

/**
 * v2: question_id references EITHER questions(id) or pm_test_questions(id),
 * discriminated by question_pool. No FK is declared because the target table
 * depends on the pool — integrity is enforced at the application layer.
 */
@Entity({ name: 'exam_answers' })
@Unique('exam_answers_exam_question_uq', ['examId', 'questionId'])
@Index('exam_answers_exam_idx', ['examId'])
@Index('exam_answers_question_idx', ['questionId'])
@Index('exam_answers_correct_idx', ['isCorrect'])
export class ExamAnswer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'exam_id', type: 'uuid' })
  examId: string;

  @ManyToOne(() => Exam, (e) => e.answers, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'exam_id' })
  exam: Exam;

  @Column({ name: 'question_id', type: 'uuid' })
  questionId: string;

  // The join is retained for past-paper questions only — services must
  // check `questionPool` before relying on `question`. CRITICAL: the real
  // FK constraint is dropped (`createForeignKeyConstraints: false`)
  // because this column doubles as a `pm_test_questions(id)` when
  // `question_pool='pm_test'`. Without this, Postgres rejects every PM-Test
  // answer insert with a FK violation against `questions(id)`. Integrity
  // is enforced at the application layer (see ExamsService.submitAnswer).
  @ManyToOne(() => Question, {
    onDelete: 'RESTRICT',
    createForeignKeyConstraints: false,
  })
  @JoinColumn({ name: 'question_id' })
  question: Question;

  @Column({
    name: 'question_pool',
    type: 'enum',
    enum: QuestionPool,
    default: QuestionPool.PAST_PAPER,
  })
  questionPool: QuestionPool;

  @Column({ name: 'selected_option_id', type: 'uuid', nullable: true })
  selectedOptionId: string | null;

  // CRITICAL: FK to options(id) is intentionally dropped. The column
  // doubles as a `pm_test_options(id)` when `question_pool='pm_test'`
  // — same dual-target situation as `question_id` above. Without
  // `createForeignKeyConstraints: false`, every PM-Test answer
  // insert fails at the DB level (selected_option_id is valid in
  // pm_test_options but the FK points at options). Integrity is
  // enforced at the application layer: ExamsService.submitAnswer
  // validates against the correct table before insert.
  @ManyToOne(() => Option, {
    nullable: true,
    onDelete: 'SET NULL',
    createForeignKeyConstraints: false,
  })
  @JoinColumn({ name: 'selected_option_id' })
  selectedOption: Option | null;

  @Column({ name: 'typed_answer', type: 'text', nullable: true })
  typedAnswer: string | null;

  @Column({ name: 'is_correct', type: 'bool', nullable: true })
  isCorrect: boolean | null;

  @Column({ name: 'time_spent_ms', type: 'int', nullable: true })
  timeSpentMs: number | null;

  // v2: did the student open the inline explanation? Signals engagement.
  @Column({ name: 'explanation_viewed', type: 'bool', default: false })
  explanationViewed: boolean;

  @CreateDateColumn({ name: 'answered_at', type: 'timestamptz' })
  answeredAt: Date;
}
