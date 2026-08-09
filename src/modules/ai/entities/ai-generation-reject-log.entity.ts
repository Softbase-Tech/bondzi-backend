import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One row per validation-failure during AI generation. Raw; pruned by
 * the retention cron at 30 days. See sibling
 * `ai_generation_reject_agg` for the rolled-up counters that outlive
 * the raw retention window.
 */
@Entity({ name: 'ai_generation_reject_log' })
@Index('idx_reject_log_created_at', ['createdAt'])
@Index('idx_reject_log_reason_model', ['reason', 'model'])
export class AiGenerationRejectLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'job_id', type: 'uuid', nullable: true })
  jobId: string | null;

  /** `question_generation` | `explanation` */
  @Column({ type: 'text' })
  action: string;

  /** `bedrock` | `ollama` */
  @Column({ type: 'text' })
  provider: string;

  /** Bedrock model id verbatim, or `ollama:<name>`. */
  @Column({ type: 'text' })
  model: string;

  /** Machine-readable rejection reason — see validator enums. */
  @Column({ type: 'text' })
  reason: string;

  /** Human-readable context: which invariant failed, which field, etc. */
  @Column({ type: 'text', nullable: true })
  detail: string | null;

  /** Model's actual output, truncated to a sane bound (~16k chars). */
  @Column({ name: 'raw_output', type: 'text', nullable: true })
  rawOutput: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
