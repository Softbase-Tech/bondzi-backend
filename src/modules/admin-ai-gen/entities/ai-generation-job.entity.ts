import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AiJobStatus, AiJobType } from '../../../common/types/enums';
import { User } from '../../users/entities/user.entity';

/**
 * Admin-triggered AI generation job. Two job types: bulk explanations (fills
 * questions.explanation for past-paper questions) and PM Test generation
 * (creates pm_test_questions with status=pending_review).
 *
 * `parameters` is the full request body from the preview/confirm step so we
 * always have a replayable record of what was requested.
 */
@Entity({ name: 'ai_generation_jobs' })
export class AiGenerationJob {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'job_type', type: 'enum', enum: AiJobType })
  jobType: AiJobType;

  @Column({
    type: 'enum',
    enum: AiJobStatus,
    default: AiJobStatus.PENDING,
  })
  status: AiJobStatus;

  @Column({ name: 'triggered_by', type: 'uuid' })
  triggeredBy: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'triggered_by' })
  triggeredByUser: User;

  @Column({ type: 'jsonb' })
  parameters: Record<string, unknown>;

  @Column({ name: 'total_items', type: 'int', nullable: true })
  totalItems: number | null;

  @Column({ name: 'completed_items', type: 'int', default: 0 })
  completedItems: number;

  @Column({ name: 'failed_items', type: 'int', default: 0 })
  failedItems: number;

  @Column({
    name: 'estimated_cost_usd',
    type: 'numeric',
    precision: 10,
    scale: 4,
    nullable: true,
  })
  estimatedCostUsd: string | null;

  @Column({
    name: 'actual_cost_usd',
    type: 'numeric',
    precision: 10,
    scale: 4,
    nullable: true,
  })
  actualCostUsd: string | null;

  @Column({ name: 'model_used', type: 'text', nullable: true })
  modelUsed: string | null;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ name: 'error_log', type: 'text', nullable: true })
  errorLog: string | null;

  /**
   * Co-sign tracking for jobs whose estimated cost exceeds
   * AI_COSIGN_THRESHOLD_USD. The creator (triggered_by) writes the
   * row with status=PENDING_APPROVAL; a SECOND admin (must differ)
   * sets approved_by + approved_at and flips status to PENDING.
   */
  @Column({ name: 'approved_by', type: 'uuid', nullable: true })
  approvedBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'approved_by' })
  approvedByUser: User | null;

  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
