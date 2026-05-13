import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * Immutable audit log of every inbound webhook delivery across all payment
 * providers. (provider, provider_event_id) is the idempotency key — when
 * a provider redelivers, the insert fails on conflict and the webhook
 * handler returns 200 without reprocessing. Never delete these rows.
 */
@Entity({ name: 'payment_events' })
@Index('payment_events_provider_event_uq', ['provider', 'providerEventId'], {
  unique: true,
})
@Index('payment_events_type_idx', ['eventType'])
@Index('payment_events_processed_idx', ['processed'])
export class PaymentEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  /** Payment provider that delivered this event ('paystack', 'stripe', ...). */
  @Column({ type: 'text' })
  provider: string;

  @Column({ name: 'provider_event_id', type: 'text' })
  providerEventId: string;

  @Column({ name: 'event_type', type: 'text' })
  eventType: string;

  @Column({ name: 'raw_payload', type: 'jsonb' })
  rawPayload: Record<string, unknown>;

  @Column({ type: 'bool', default: false })
  processed: boolean;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
