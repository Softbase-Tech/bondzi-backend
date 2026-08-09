import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Rolled-up rejection counter by (week × reason × provider × model).
 * Outlives the 30-day raw log so long-term failure trends stay
 * visible even after individual reject rows are pruned.
 *
 * `weekStart` is the Monday of the ISO week (UTC), matching the
 * leaderboard week convention. UPSERTed atomically alongside every
 * raw log insert — the two writes must land in the same transaction
 * or the aggregates drift.
 */
@Entity({ name: 'ai_generation_reject_agg' })
@Index('idx_reject_agg_reason_week', ['reason', 'weekStart'])
export class AiGenerationRejectAgg {
  /** ISO date (Monday of the week, UTC). */
  @PrimaryColumn({ name: 'week_start', type: 'date' })
  weekStart: string;

  @PrimaryColumn({ type: 'text' })
  reason: string;

  @PrimaryColumn({ type: 'text' })
  provider: string;

  @PrimaryColumn({ type: 'text' })
  model: string;

  @Column({ type: 'int', default: 0 })
  count: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
