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
import { Achievement } from './achievement.entity';

/**
 * Per-user progress row for a single achievement. Sparse — a row
 * only exists once the service has evaluated the user against the
 * achievement at least once. `unlocked_at` is NULL while in progress
 * and stamped to `now()` the first time the threshold is crossed.
 * `progress_snapshot` records the last-seen metric value so admin
 * dashboards can render "22 / 50" without recomputing.
 */
@Entity('user_achievements')
@Unique('uq_user_achievements_user_achievement', ['userId', 'achievementId'])
@Index('idx_user_achievements_user_unlocked', ['userId', 'unlockedAt'])
export class UserAchievement {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'achievement_id', type: 'uuid' })
  achievementId: string;

  @ManyToOne(() => Achievement, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'achievement_id' })
  achievement: Achievement;

  @Column({ name: 'unlocked_at', type: 'timestamptz', nullable: true })
  unlockedAt: Date | null;

  @Column({ name: 'progress_snapshot', type: 'int', default: 0 })
  progressSnapshot: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
