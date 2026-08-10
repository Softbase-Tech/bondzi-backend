import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { PartnerAttributionSource } from '../../../common/types/enums';
import { User } from '../../users/entities/user.entity';
import { Partner } from './partner.entity';
import { PartnerReferralCode } from './partner-referral-code.entity';

/**
 * Sticky user→partner link. `user_id` is unique at the DB level so a
 * user can be attributed to exactly one partner, ever. Re-runs of the
 * attribution flow (double-fire, user resubmits register) no-op.
 *
 * `suspicion_flags` is a text array so all triggered fraud checks
 * (same_device, same_phone_root, self_referral, etc.) live on the
 * row itself. Commissions written against an attribution with flags
 * land as `flagged` instead of `pending`.
 */
@Entity({ name: 'partner_attributions' })
export class PartnerAttribution {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid', unique: true })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'partner_id', type: 'uuid' })
  partnerId: string;

  @ManyToOne(() => Partner, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'partner_id' })
  partner: Partner;

  @Column({ name: 'partner_referral_code_id', type: 'uuid' })
  partnerReferralCodeId: string;

  @ManyToOne(() => PartnerReferralCode, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'partner_referral_code_id' })
  referralCode: PartnerReferralCode;

  @Column({
    name: 'attribution_source',
    type: 'enum',
    enum: PartnerAttributionSource,
    enumName: 'partner_attribution_source_enum',
  })
  attributionSource: PartnerAttributionSource;

  @Column({
    name: 'attributed_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  attributedAt: Date;

  @Column({
    name: 'suspicion_flags',
    type: 'text',
    array: true,
    default: '{}',
  })
  suspicionFlags: string[];

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
