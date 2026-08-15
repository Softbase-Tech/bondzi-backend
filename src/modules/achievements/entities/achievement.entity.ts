import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Metric that each achievement's `threshold_value` is compared
 * against. Kept as a string literal union both in TS and as a CHECK
 * constraint at the DB boundary (see migration 2140).
 *
 *   answers_count   — cumulative questions answered (any subject)
 *   streak_max      — max(current streak, longest streak) — mirrors
 *                     the mobile client's original 5-day-streak card
 *                     which unlocked on EITHER signal
 *   longest_streak  — longest streak strictly, e.g. the 14-day badge
 *   accuracy_pct    — rolling accuracy as an integer percent; when
 *                     `min_answers` is set, the achievement only
 *                     unlocks once the student has cleared that gate
 *   level           — current gamification level
 */
export type AchievementMetricKey =
  | 'answers_count'
  | 'streak_max'
  | 'longest_streak'
  | 'accuracy_pct'
  | 'level';

@Entity('achievements')
@Index('idx_achievements_active_sort', ['isActive', 'sortOrder'])
export class Achievement {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Stable slug used by the mobile client for local overrides
   * (icons that ship in the bundle, telemetry). Unique across all
   * achievements, active or not — retiring a badge doesn't free
   * up its key, so we don't accidentally recycle it.
   */
  @Column({ type: 'text', unique: true })
  key: string;

  @Column({ type: 'text' })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'metric_key', type: 'text' })
  metricKey: AchievementMetricKey;

  @Column({ name: 'threshold_value', type: 'int' })
  thresholdValue: number;

  /**
   * Optional lower bound on `answers_count` that gates the
   * achievement from unlocking. Used by the "70% accuracy" milestone
   * so a brand-new user with 2 lucky-guessed correct answers doesn't
   * see it flip green.
   */
  @Column({ name: 'min_answers', type: 'int', nullable: true })
  minAnswers: number | null;

  /**
   * Icon key the mobile client maps to a bundled IconName. Not a
   * URL — a rename here would break a shipped build, so we lean
   * on the fixed set: 'check', 'flame', 'sparkle', 'star', 'trophy',
   * 'lightning'.
   */
  @Column({ name: 'icon_key', type: 'text' })
  iconKey: string;

  @Column({ name: 'gradient_start', type: 'text' })
  gradientStart: string;

  @Column({ name: 'gradient_end', type: 'text' })
  gradientEnd: string;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  /**
   * `false` retires the achievement — hidden from mobile, kept in
   * admin so old user_achievements rows still resolve. We never
   * hard-delete a catalogue row because per-user unlock history
   * would be orphaned.
   */
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
