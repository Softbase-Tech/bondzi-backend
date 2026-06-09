import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Subscription } from '../../subscriptions/entities/subscription.entity';
import { SubscriptionPlanEntity } from '../../subscriptions/plans/entities/subscription-plan.entity';
import { PromoCode } from '../../promo-codes/entities/promo-code.entity';
import {
  BillingInterval,
  PaymentAttemptStatus,
} from '../../../common/types/enums';

// TypeORM's numeric columns come back as strings — coerce to number for
// callers that do arithmetic without typeof-string juggling. Declared
// at module scope (above the entity class) because the column
// decorators reference them at class-definition time.
const numericTransformer = {
  to: (value: number) => value,
  from: (value: string | null) => (value === null ? 0 : parseFloat(value)),
};
const nullableNumericTransformer = {
  to: (value: number | null) => value,
  from: (value: string | null) => (value === null ? null : parseFloat(value)),
};

/**
 * A single checkout attempt — every initiate call writes one of these
 * BEFORE Paystack is called. The webhook handler gates on
 * `providerReference` to confirm "yes, we initiated this payment"
 * before applying any downstream subscription change. See the
 * `1900-PaymentsAndBillingLog` migration for the trust model.
 *
 * Status lifecycle:
 *
 *   pending ──► paid       (webhook charge.success / verify confirmed)
 *           ──► failed     (Paystack told us no, terminal)
 *           ──► abandoned  (sweep job after N hours of silence)
 *
 *   paid    ──► refunded   (refund.processed webhook later)
 *
 * Indexes mirror the hot paths in the 1900 migration. The `subscriptionId`
 * relation is nullable because pre-payment rows aren't linked to a
 * subscription yet — the link is back-filled once `verify` /
 * `applyWebhookActivation` lands and inserts/updates the subscription.
 */
@Entity({ name: 'payment_attempts' })
@Index('idx_payment_attempts_user_initiated', ['userId', 'initiatedAt'])
@Index('idx_payment_attempts_status_created', ['status', 'createdAt'])
export class PaymentAttempt {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  /**
   * Populated AFTER the payment confirms and the corresponding
   * subscription row is created / updated. NULL while the attempt is
   * still in PENDING state.
   */
  @Column({ name: 'subscription_id', type: 'uuid', nullable: true })
  subscriptionId: string | null;

  @ManyToOne(() => Subscription, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'subscription_id' })
  subscription: Subscription | null;

  @Column({ name: 'plan_id', type: 'uuid', nullable: true })
  planId: string | null;

  @ManyToOne(() => SubscriptionPlanEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'plan_id' })
  plan: SubscriptionPlanEntity | null;

  /**
   * Null for one-time (Plus) charges; the cadence enum for recurring
   * Pro charges.
   */
  @Column({
    name: 'billing_interval',
    type: 'enum',
    enum: BillingInterval,
    nullable: true,
  })
  billingInterval: BillingInterval | null;

  /** Amount in pesewas — what Paystack actually charged. */
  @Column({ name: 'amount_minor', type: 'int' })
  amountMinor: number;

  /** Display amount in cedis, stored as numeric(10,2). */
  @Column({
    name: 'amount_ghs',
    type: 'numeric',
    precision: 10,
    scale: 2,
    transformer: numericTransformer,
  })
  amountGhs: number;

  @Column({ type: 'text', default: 'GHS' })
  currency: string;

  @Column({ type: 'text' })
  provider: string;

  /**
   * Our server-issued reference. UNIQUE — the column the webhook
   * handler resolves on. Format: `pm_<userId-slice>_<timestamp>_<rand>`.
   */
  @Column({ name: 'provider_reference', type: 'text', unique: true })
  providerReference: string;

  /** Paystack's `event.id` once the confirming webhook lands. */
  @Column({ name: 'provider_event_id', type: 'text', nullable: true })
  providerEventId: string | null;

  @Column({ name: 'provider_customer_id', type: 'text', nullable: true })
  providerCustomerId: string | null;

  @Column({ name: 'promo_code_id', type: 'uuid', nullable: true })
  promoCodeId: string | null;

  @ManyToOne(() => PromoCode, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'promo_code_id' })
  promoCode: PromoCode | null;

  @Column({
    name: 'discount_amount',
    type: 'numeric',
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: nullableNumericTransformer,
  })
  discountAmount: number | null;

  @Column({
    type: 'enum',
    enum: PaymentAttemptStatus,
    default: PaymentAttemptStatus.PENDING,
  })
  status: PaymentAttemptStatus;

  @Column({ name: 'initiated_at', type: 'timestamptz', default: () => 'NOW()' })
  initiatedAt: Date;

  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt: Date | null;

  @Column({ name: 'failed_at', type: 'timestamptz', nullable: true })
  failedAt: Date | null;

  @Column({ name: 'refunded_at', type: 'timestamptz', nullable: true })
  refundedAt: Date | null;

  @Column({ name: 'abandoned_at', type: 'timestamptz', nullable: true })
  abandonedAt: Date | null;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason: string | null;

  /** Free-form metadata captured at initiate time (account, level, etc). */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
