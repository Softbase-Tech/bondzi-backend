import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  ExamMode,
  ExamStatus,
  ExamType,
  QuestionPool,
} from '../../../common/types/enums';
import { User } from '../../users/entities/user.entity';
import { ExamAnswer } from './exam-answer.entity';

@Entity({ name: 'exams' })
@Index('idx_exams_user', ['userId', 'status'])
@Index('idx_exams_type', ['examType', 'createdAt'])
export class Exam {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'exam_type', type: 'enum', enum: ExamType })
  examType: ExamType;

  @Column({ type: 'enum', enum: ExamMode })
  mode: ExamMode;

  @Column({
    name: 'question_pool',
    type: 'enum',
    enum: QuestionPool,
    default: QuestionPool.PAST_PAPER,
  })
  questionPool: QuestionPool;

  @Column({ type: 'enum', enum: ExamStatus, default: ExamStatus.IN_PROGRESS })
  status: ExamStatus;

  @Column({ name: 'subject_filter', type: 'jsonb', nullable: true })
  subjectFilter: Record<string, unknown> | null;

  // Ordered list of question IDs — preserves sequence across pause/resume.
  @Column({
    name: 'question_ids',
    type: 'uuid',
    array: true,
    default: () => 'ARRAY[]::uuid[]',
  })
  questionIds: string[];

  @Column({ name: 'duration_seconds', type: 'int', nullable: true })
  durationSeconds: number | null;

  @Column({ type: 'int', nullable: true })
  score: number | null;

  @Column({ name: 'total_questions', type: 'int', nullable: true })
  totalQuestions: number | null;

  @Column({
    name: 'percent_score',
    type: 'numeric',
    precision: 5,
    scale: 2,
    nullable: true,
  })
  percentScore: string | null;

  @Column({ name: 'xp_earned', type: 'int', default: 0 })
  xpEarned: number;

  @Column({ name: 'started_at', type: 'timestamptz', default: () => 'now()' })
  startedAt: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => ExamAnswer, (a) => a.exam)
  answers: ExamAnswer[];
}
