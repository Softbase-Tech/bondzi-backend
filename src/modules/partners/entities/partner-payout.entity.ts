import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { MomoProvider, PartnerPayoutStatus } from '../../../common/types/enums';
import { User } from '../../users/entities/user.entity';
import { Partner } from './partner.entity';

/**
 * One row per weekly payout. Admin creates a row when they're
 * ready to pay a partner; the row aggregates all
 * approved-and-unpaid commissions for that partner as of the
 * payout's `week_of` (typically the current Monday).
 *
 * Statuses:
 *   pending — payout created, MoMo transfer not yet sent
 *   paid    — admin marked paid, momo_reference filled
 *   failed  — MoMo bounced; commissions revert to `approved` so a
 *             fresh payout can be created
 *
 * The partial UNIQUE index in the migration
 *   (partner_id, week_of) WHERE status IN ('pending','paid')
 * prevents two live payouts for the same week while still letting a
 * failed payout be retried.
 */
@Entity({ name: 'partner_payouts' })
@Index('idx_partner_payouts_partner_status', ['partnerId', 'status'])
export class PartnerPayout {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'partner_id', type: 'uuid' })
  partnerId: string;

  @ManyToOne(() => Partner, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'partner_id' })
  partner: Partner;

  @Column({ name: 'week_of', type: 'date' })
  weekOf: string;

  @Column({ name: 'amount_ghs', type: 'numeric', precision: 10, scale: 2 })
  amountGhs: string;

  @Column({
    type: 'enum',
    enum: PartnerPayoutStatus,
    enumName: 'partner_payout_status_enum',
    default: PartnerPayoutStatus.PENDING,
  })
  status: PartnerPayoutStatus;

  @Column({ name: 'invoice_number', type: 'text', unique: true })
  invoiceNumber: string;

  @Column({ name: 'invoice_pdf_url', type: 'text', nullable: true })
  invoicePdfUrl: string | null;

  @Column({
    name: 'momo_provider',
    type: 'enum',
    enum: MomoProvider,
    enumName: 'momo_provider_enum',
  })
  momoProvider: MomoProvider;

  @Column({ name: 'momo_number', type: 'text' })
  momoNumber: string;

  @Column({ name: 'momo_reference', type: 'text', nullable: true })
  momoReference: string | null;

  @Column({ name: 'marked_paid_by', type: 'uuid', nullable: true })
  markedPaidBy: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'marked_paid_by' })
  markedPaidByUser: User | null;

  @Column({ name: 'marked_paid_at', type: 'timestamptz', nullable: true })
  markedPaidAt: Date | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
