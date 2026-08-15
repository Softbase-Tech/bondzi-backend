import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A user-triggered AI Study Review. Unlike the (now-retired) daily
 * weakness narrative, a review is NEVER auto-generated — the student
 * taps "Generate review" and one row is written.
 *
 * Each row IS the quota ledger: the monthly limit is enforced by
 * counting rows created since the start of the current Accra month
 * (see AiReviewService.assertMonthlyQuota). There is no separate
 * usage counter and no carry-forward — a new month simply has zero
 * matching rows, so the count resets on its own.
 *
 * `content` is markdown (the 6-section report). `summary` is a short
 * plain-text teaser shown on the Home card so the client doesn't have
 * to parse the markdown to render the card.
 */
@Entity({ name: 'ai_reviews' })
@Index('idx_ai_reviews_user_created', ['userId', 'createdAt'])
export class AiReview {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  /**
   * 'all' for a whole-account review (the only scope the client sends
   * today) or a subject uuid if we ever add scoped reviews. Kept as
   * TEXT (not an FK) to mirror weakness_narratives.subject_scope.
   */
  @Column({ name: 'subject_scope', type: 'text', default: 'all' })
  subjectScope: string;

  /** The full 6-section markdown report. */
  @Column({ name: 'content', type: 'text' })
  content: string;

  /** Short plain-text teaser for the Home card (first paragraph). */
  @Column({ name: 'summary', type: 'text' })
  summary: string;

  /**
   * 'bootstrap' — canned, no Bedrock call, does NOT consume quota
   * (the user had no weakness signal yet). 'personalised' — real AI
   * report; consumes one monthly quota unit.
   */
  @Column({ name: 'mode', type: 'text', default: 'personalised' })
  mode: 'bootstrap' | 'personalised';

  @Column({ name: 'model', type: 'text' })
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

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
