import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { FlagReason, QuestionPool } from '../../../common/types/enums';
import { Question } from './question.entity';
import { User } from '../../users/entities/user.entity';

@Entity({ name: 'question_flags' })
@Index('question_flags_q_resolved_idx', ['questionId', 'isResolved'])
export class QuestionFlag {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'question_id', type: 'uuid' })
  questionId: string;

  // FK is retained to questions only — PM Test flags are validated at app layer.
  @ManyToOne(() => Question, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'question_id' })
  question: Question;

  @Column({
    name: 'question_pool',
    type: 'enum',
    enum: QuestionPool,
    default: QuestionPool.PAST_PAPER,
  })
  questionPool: QuestionPool;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user: User;

  // Spec DB §7.2: reason is TEXT (admins want free-form flexibility).
  // App-layer validation (class-validator) keeps the value inside the
  // FlagReason enum so we don't get drift in practice.
  @Column({ type: 'text' })
  reason: FlagReason;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ name: 'is_resolved', type: 'bool', default: false })
  isResolved: boolean;

  @Column({ name: 'resolved_by', type: 'uuid', nullable: true })
  resolvedBy: string | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
