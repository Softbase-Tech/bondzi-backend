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
import { User } from '../../users/entities/user.entity';
import { Question } from '../../questions/entities/question.entity';
import { QuestionPool } from '../../../common/types/enums';

/**
 * v2: srs cards can point at either pool. The join to Question is retained as a
 * convenience for past-paper cards; PM Test cards must be resolved via
 * PmTestQuestion in the application layer (discriminated by question_pool).
 */
@Entity({ name: 'srs_cards' })
@Unique('srs_user_question_pool_uq', ['userId', 'questionId', 'questionPool'])
@Index('idx_srs_due', ['userId', 'nextReviewAt'])
export class SrsCard {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'question_id', type: 'uuid' })
  questionId: string;

  // The join is retained for past-paper cards only. CRITICAL: the real FK
  // is dropped because this column also stores `pm_test_questions(id)`
  // when `question_pool='pm_test'`. With a hard FK to `questions(id)`
  // every PM-Test SRS card insert would 500. Integrity is enforced at the
  // application layer (SrsService.upsertFromAnswer branches on pool).
  @ManyToOne(() => Question, {
    onDelete: 'CASCADE',
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

  @Column({ name: 'ease_factor', type: 'float', default: 2.5 })
  easeFactor: number;

  @Column({ name: 'interval_days', type: 'int', default: 1 })
  intervalDays: number;

  @Column({ type: 'int', default: 0 })
  repetitions: number;

  @Column({ name: 'last_quality', type: 'int', nullable: true })
  lastQuality: number | null;

  @Column({
    name: 'next_review_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  nextReviewAt: Date;

  @Column({ name: 'last_reviewed_at', type: 'timestamptz', nullable: true })
  lastReviewedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
