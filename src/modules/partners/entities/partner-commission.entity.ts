import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import {
  PartnerCommissionStatus,
  PartnerCommissionType,
} from '../../../common/types/enums';
import { Subscription } from '../../subscriptions/entities/subscription.entity';
import { User } from '../../users/entities/user.entity';
import { Partner } from './partner.entity';
import { PartnerPayout } from './partner-payout.entity';
import { PartnerTermsVersion } from './partner-terms-version.entity';

/**
 * The commission ledger. Every credit lives here.
 *
 * The unique constraint on (partner_id, type, dedup_key) means the
 * same triggering event cannot double-credit. `dedup_key` is
 * type-specific:
 *   - plus_subscription             → subscription.id
 *   - signup_batch                  → sorted array of the 10 user_ids
 *                                     as a comma-joined string
 *   - answers_bonus                 → user_id + ':' + threshold
 *                                     (e.g. `<uuid>:100`)
 *   - plus_subscription_clawback    → subscription.id (matches the
 *                                     positive row it offsets)
 *
 * Amount is frozen at earn time via `terms_version_id` so retroactive
 * terms edits never re-price historical commissions. Status
 * progresses `pending → approved → paid` or `→ flagged → approved`
 * (admin resolves) or `→ clawed_back` (refund path).
 */
@Entity({ name: 'partner_commissions' })
@Index('idx_partner_comm_status', ['partnerId', 'status'])
@Index('idx_partner_comm_earned', ['earnedAt'])
export class PartnerCommission {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'partner_id', type: 'uuid' })
  partnerId: string;

  @ManyToOne(() => Partner, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'partner_id' })
  partner: Partner;

  @Column({
    type: 'enum',
    enum: PartnerCommissionType,
    enumName: 'partner_commission_type_enum',
  })
  type: PartnerCommissionType;

  @Column({ name: 'amount_ghs', type: 'numeric', precision: 10, scale: 2 })
  amountGhs: string;

  @Column({ type: 'text', default: 'GHS' })
  currency: string;

  @Column({
    type: 'enum',
    enum: PartnerCommissionStatus,
    enumName: 'partner_commission_status_enum',
    default: PartnerCommissionStatus.PENDING,
  })
  status: PartnerCommissionStatus;

  @Column({
    name: 'earned_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  earnedAt: Date;

  @Column({ name: 'paid_out_id', type: 'uuid', nullable: true })
  paidOutId: string | null;

  @ManyToOne(() => PartnerPayout, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'paid_out_id' })
  paidOut: PartnerPayout | null;

  @Column({ name: 'terms_version_id', type: 'uuid' })
  termsVersionId: string;

  @ManyToOne(() => PartnerTermsVersion, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'terms_version_id' })
  termsVersion: PartnerTermsVersion;

  @Column({ name: 'subscription_id', type: 'uuid', nullable: true })
  subscriptionId: string | null;

  @ManyToOne(() => Subscription, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'subscription_id' })
  subscription: Subscription | null;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({
    name: 'batch_user_ids',
    type: 'uuid',
    array: true,
    nullable: true,
  })
  batchUserIds: string[] | null;

  @Column({ name: 'flag_reason', type: 'text', nullable: true })
  flagReason: string | null;

  @Column({ name: 'flagged_at', type: 'timestamptz', nullable: true })
  flaggedAt: Date | null;

  @Column({ name: 'dedup_key', type: 'text' })
  dedupKey: string;

  @Column({
    name: 'eligibility_meta',
    type: 'jsonb',
    default: () => "'{}'::jsonb",
  })
  eligibilityMeta: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
