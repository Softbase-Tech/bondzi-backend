import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { SnapshotMetrics } from '../collectors/collector.types';

/**
 * One immutable row per calendar day (UTC).
 *
 * Reports *read* snapshots; they never recompute aggregates from raw
 * tables. That keeps a weekly report seven indexed row reads instead of
 * seven full-table scans, preserves history after raw data is pruned, and
 * means a failed email never costs a recompute.
 *
 * The generated columns declared in migration 2370000000000 are mapped
 * read-only here: TypeORM must never try to write them.
 */
@Entity('report_daily_snapshot')
@Index('idx_snapshot_date_desc', ['snapshotDate'])
export class ReportDailySnapshot {
  /** UTC calendar date, `YYYY-MM-DD`. The natural key. */
  @PrimaryColumn({ name: 'snapshot_date', type: 'date' })
  snapshotDate: string;

  /** Bumped when the shape of `metrics` changes incompatibly. */
  @Column({ name: 'schema_version', type: 'smallint', default: 1 })
  schemaVersion: number;

  @Column({ type: 'jsonb' })
  metrics: SnapshotMetrics;

  @Column({ name: 'computed_at', type: 'timestamptz' })
  computedAt: Date;

  @Column({ name: 'compute_ms', type: 'integer', nullable: true })
  computeMs: number | null;

  // ---- generated, read-only ------------------------------------------
  @Column({ type: 'integer', nullable: true, insert: false, update: false })
  signups: number | null;

  @Column({ type: 'integer', nullable: true, insert: false, update: false })
  dau: number | null;

  @Column({
    name: 'new_pro',
    type: 'integer',
    nullable: true,
    insert: false,
    update: false,
  })
  newPro: number | null;

  @Column({
    name: 'revenue_ghs',
    type: 'numeric',
    nullable: true,
    insert: false,
    update: false,
  })
  revenueGhs: string | null;

  @Column({
    name: 'ai_spend_usd',
    type: 'numeric',
    nullable: true,
    insert: false,
    update: false,
  })
  aiSpendUsd: string | null;
}
