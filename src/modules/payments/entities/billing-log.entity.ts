import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Subscription } from '../../subscriptions/entities/subscription.entity';
import { PaymentAttempt } from './payment-attempt.entity';
import { BillingLogProcessStatus } from '../../../common/types/enums';

/**
 * Append-only raw-payload sink. Every webhook lands here first
 * (idempotent on `provider` + `provider_event_id`) before any
 * downstream effect is applied. Carries the verbatim Paystack body so
 * disputes can be reconstructed weeks or months later.
 *
 * Lookup:
 *   - by `(provider, provider_event_id)` — unique key, idempotency
 *   - by `reference` — match an event back to its payment attempt
 *   - by `user_id` — admin "what did Paystack send us about this user"
 *   - by `process_status IN ('no_matching_payment', 'error')` — admin
 *     security/error tail
 *
 * Not the same as `payment_attempts`: that table is one row per
 * checkout intent; `billing_log` is one row per RAW webhook event. A
 * single payment_attempt can have multiple billing_log rows over its
 * lifetime (charge.success, refund.processed, …).
 */
@Entity({ name: 'billing_log' })
@Unique('uq_billing_log_provider_event', ['provider', 'providerEventId'])
@Index('idx_billing_log_received', ['receivedAt'])
@Index('idx_billing_log_reference', ['reference'])
@Index('idx_billing_log_user', ['userId'])
export class BillingLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 'paystack' today; multi-provider-ready. */
  @Column({ type: 'text' })
  provider: string;

  /** e.g. 'charge.success', 'invoice.update', 'refund.processed'. */
  @Column({ name: 'event_type', type: 'text' })
  eventType: string;

  /** Paystack's own event id — UNIQUE per (provider, event_id). */
  @Column({ name: 'provider_event_id', type: 'text' })
  providerEventId: string;

  @Column({ type: 'text', nullable: true })
  reference: string | null;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ name: 'payment_attempt_id', type: 'uuid', nullable: true })
  paymentAttemptId: string | null;

  @ManyToOne(() => PaymentAttempt, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'payment_attempt_id' })
  paymentAttempt: PaymentAttempt | null;

  @Column({ name: 'subscription_id', type: 'uuid', nullable: true })
  subscriptionId: string | null;

  @ManyToOne(() => Subscription, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'subscription_id' })
  subscription: Subscription | null;

  /** Verbatim Paystack body. The forensic anchor. */
  @Column({ name: 'raw_payload', type: 'jsonb' })
  rawPayload: Record<string, unknown>;

  /** X-Paystack-Signature value we received (if any). */
  @Column({ type: 'text', nullable: true })
  signature: string | null;

  /** Our normalised view of the payload — same shape across providers. */
  @Column({ type: 'jsonb', nullable: true })
  normalized: Record<string, unknown> | null;

  /** Paystack's reported event timestamp. */
  @Column({ name: 'occurred_at', type: 'timestamptz', nullable: true })
  occurredAt: Date | null;

  /** Our wall clock when the webhook hit our edge. */
  @Column({ name: 'received_at', type: 'timestamptz', default: () => 'NOW()' })
  receivedAt: Date;

  /** Our wall clock when downstream processing completed. */
  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt: Date | null;

  @Column({
    name: 'process_status',
    type: 'enum',
    enum: BillingLogProcessStatus,
    default: BillingLogProcessStatus.RECEIVED,
  })
  processStatus: BillingLogProcessStatus;

  @Column({ name: 'process_error', type: 'text', nullable: true })
  processError: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
