import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AiAction } from '../../../common/types/enums';
import { User } from '../../users/entities/user.entity';
import { Question } from '../../questions/entities/question.entity';

@Entity({ name: 'ai_usage_log' })
@Index('ai_usage_created_idx', ['createdAt'])
@Index('ai_usage_user_idx', ['userId'])
export class AiUsageLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ name: 'question_id', type: 'uuid', nullable: true })
  questionId: string | null;

  @ManyToOne(() => Question, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'question_id' })
  question: Question | null;

  // Spec §7.2: link each AI call back to the generation job that triggered it.
  // Nullable — on-demand calls outside of an admin job simply don't set it.
  @Column({ name: 'job_id', type: 'uuid', nullable: true })
  jobId: string | null;

  @Column({ type: 'enum', enum: AiAction })
  action: AiAction;

  /**
   * Which client actually served this call: `bedrock` or `ollama`.
   * Derivable from `model` in most cases (`ollama:` prefix), but
   * dedicating a column keeps admin dashboard queries clean and
   * survives any future renaming of the model tag convention.
   */
  @Column({ type: 'text', default: 'bedrock' })
  provider: string;

  @Column({ type: 'text' })
  model: string;

  @Column({ name: 'input_tokens', type: 'int', nullable: true })
  inputTokens: number | null;

  @Column({ name: 'output_tokens', type: 'int', nullable: true })
  outputTokens: number | null;

  @Column({
    name: 'cost_usd',
    type: 'numeric',
    precision: 12,
    scale: 6,
    nullable: true,
  })
  costUsd: string | null;

  @Column({ name: 'latency_ms', type: 'int', nullable: true })
  latencyMs: number | null;

  @Column({ name: 'cache_hit', type: 'bool', default: false })
  cacheHit: boolean;

  @Column({ name: 'failover_used', type: 'bool', default: false })
  failoverUsed: boolean;

  @Column({ name: 'prompt_version', type: 'text', nullable: true })
  promptVersion: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
