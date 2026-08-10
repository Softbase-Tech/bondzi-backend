import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Partner } from './partner.entity';

/**
 * Referral codes belonging to a partner. One default per partner
 * (created at registration, `is_default = true`), plus any number of
 * additional custom-labelled codes the partner creates from the
 * portal ("Instagram Feb", "school flyer").
 *
 * `code` is globally unique across every partner — a student typing
 * a partner code into the wrong field on register can't accidentally
 * resolve because the register form has two separate fields (student
 * `referralCode` vs partner `partnerReferralCode`) that hit different
 * lookup tables.
 */
@Entity({ name: 'partner_referral_codes' })
@Index('idx_partner_codes_partner', ['partnerId'])
export class PartnerReferralCode {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'partner_id', type: 'uuid' })
  partnerId: string;

  @ManyToOne(() => Partner, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'partner_id' })
  partner: Partner;

  @Column({ type: 'text', unique: true })
  code: string;

  @Column({ type: 'text', default: 'Default code' })
  label: string;

  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault: boolean;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
