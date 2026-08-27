import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One nightly golden-set evaluation run (premium plan §7.3). The
 * `metrics` jsonb is the probe report:
 *
 *   {
 *     keyAgreement:    { agreed, mismatched, errors, mismatchedIds[] },
 *     explanationEval: { passed, failed, reasons: {reason: count} },
 *     judge:           { n, avgAccuracy, avgClarity, lowIds[] },
 *   }
 */
@Entity({ name: 'ai_eval_runs' })
@Index('idx_ai_eval_runs_date', ['runDate'])
export class AiEvalRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'run_date', type: 'date' })
  runDate: string;

  @Column({ name: 'sample_size', type: 'int' })
  sampleSize: number;

  @Column({ type: 'jsonb' })
  metrics: Record<string, unknown>;

  @Column({ name: 'cost_usd', type: 'numeric', precision: 12, scale: 6 })
  costUsd: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
