import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { ExamType, LeaderboardPeriodType } from '../../../common/types/enums';

/**
 * v2 leaderboard shape — separate boards per exam_type, with weekly and monthly
 * periods and optional scope (national or school-id string). Denormalised weekly
 * XP aggregate so board reads are O(N) on a small slice.
 */
@Entity({ name: 'leaderboard_entries' })
@Unique('lb_unique', [
  'userId',
  'examType',
  'scope',
  'periodType',
  'periodStart',
])
@Index('idx_lb_period', ['examType', 'periodType', 'periodStart', 'weeklyXp'])
export class LeaderboardEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'exam_type', type: 'enum', enum: ExamType })
  examType: ExamType;

  // 'national' for the public board, or a school_id for a school-scoped board.
  @Column({ type: 'text', default: 'national' })
  scope: string;

  @Column({ name: 'period_type', type: 'enum', enum: LeaderboardPeriodType })
  periodType: LeaderboardPeriodType;

  @Column({ name: 'period_start', type: 'date' })
  periodStart: string;

  @Column({ name: 'weekly_xp', type: 'int', default: 0 })
  weeklyXp: number;

  @Column({ type: 'int', nullable: true })
  rank: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
