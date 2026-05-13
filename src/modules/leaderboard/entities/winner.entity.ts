import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ExamType, LeaderboardPeriodType } from '../../../common/types/enums';
import { User } from '../../users/entities/user.entity';

/**
 * Historical winners of weekly/monthly leaderboard cycles. Populated by the
 * admin-triggered winner-selection job, which also issues the XP prizes via the
 * gamification service.
 */
@Entity({ name: 'winners' })
@Index('idx_winners_period', ['examType', 'periodType', 'periodStart', 'rank'])
export class Winner {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'exam_type', type: 'enum', enum: ExamType })
  examType: ExamType;

  @Column({ name: 'period_type', type: 'enum', enum: LeaderboardPeriodType })
  periodType: LeaderboardPeriodType;

  @Column({ name: 'period_start', type: 'date' })
  periodStart: string;

  @Column({ type: 'int' })
  rank: number;

  @Column({ name: 'xp_earned', type: 'int' })
  xpEarned: number;

  @Column({ name: 'xp_issued', type: 'bool', default: false })
  xpIssued: boolean;

  @Column({ name: 'xp_issued_at', type: 'timestamptz', nullable: true })
  xpIssuedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
