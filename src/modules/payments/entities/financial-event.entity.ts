import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Immutable ledger of every money-touching state change in the app.
 *
 * Why a separate table from audit_log:
 *   - audit_log is keyed to admin_id (every row has a human operator).
 *     Financial events are mostly system-driven (webhook activations,
 *     scheduled renewals, refunds) and would need a nullable admin_id
 *     plus a discriminator — at which point we'd be polluting the
 *     "admin action history" table with system noise.
 *   - Retention is different. Audit log is for moderation history (1y
 *     is plenty); financial_events back compliance + dispute defense
 *     (5–7y minimum for card payments).
 *   - Indexes are different. Audit needs (admin_id, created_at);
 *     financial needs (user_id, created_at) and (event_type,
 *     created_at) for "show me every refund this week" reports.
 *
 * Event types (event_type column):
 *   activation, renewal, cancellation, expiration, refund,
 *   xp_redemption, xp_credit, plan_change, status_correction
 *
 * Source values: 'webhook' | 'admin' | 'system' | 'user' | 'job'
 */
export enum FinancialEventType {
  ACTIVATION = 'activation',
  RENEWAL = 'renewal',
  CANCELLATION = 'cancellation',
  EXPIRATION = 'expiration',
  REFUND = 'refund',
  XP_REDEMPTION = 'xp_redemption',
  XP_CREDIT = 'xp_credit',
  PLAN_CHANGE = 'plan_change',
  STATUS_CORRECTION = 'status_correction',
}

export type FinancialEventSource =
  | 'webhook'
  | 'admin'
  | 'system'
  | 'user'
  | 'job';

@Entity({ name: 'financial_events' })
@Index('idx_financial_events_user_created_at', ['userId', 'createdAt'])
@Index('idx_financial_events_type_created_at', ['eventType', 'createdAt'])
export class FinancialEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'event_type', type: 'text' })
  eventType: FinancialEventType;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ name: 'subscription_id', type: 'uuid', nullable: true })
  subscriptionId: string | null;

  /** Amount in minor units (kobo / cents). Null for non-monetary events. */
  @Column({ name: 'amount_minor', type: 'int', nullable: true })
  amountMinor: number | null;

  @Column({ type: 'text', nullable: true })
  currency: string | null;

  @Column({ type: 'text' })
  source: FinancialEventSource;

  /** Admin user id when source='admin'; null otherwise. */
  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId: string | null;

  /** Free-form audit context (provider reference, plan id, reason, etc). */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
