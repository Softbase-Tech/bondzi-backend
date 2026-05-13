import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Subject } from '../../subjects/entities/subject.entity';

@Entity({ name: 'user_subject_progress' })
@Unique('usp_user_subject_uq', ['userId', 'subjectId'])
@Index('usp_user_idx', ['userId'])
export class UserSubjectProgress {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'subject_id', type: 'uuid' })
  subjectId: string;

  @ManyToOne(() => Subject, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'subject_id' })
  subject: Subject;

  @Column({ name: 'questions_seen', type: 'int', default: 0 })
  questionsSeen: number;

  @Column({ name: 'questions_correct', type: 'int', default: 0 })
  questionsCorrect: number;

  @Column({ name: 'total_time_ms', type: 'bigint', default: 0 })
  totalTimeMs: string;

  @Column({ name: 'streak_days', type: 'int', default: 0 })
  streakDays: number;

  @Column({ name: 'longest_streak', type: 'int', default: 0 })
  longestStreak: number;

  @Column({ name: 'topic_accuracy', type: 'jsonb', nullable: true })
  topicAccuracy: Record<string, { seen: number; correct: number }> | null;

  @Column({ name: 'last_studied_at', type: 'timestamptz', nullable: true })
  lastStudiedAt: Date | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
