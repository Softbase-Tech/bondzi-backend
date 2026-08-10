import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Partner } from './partner.entity';
import { PartnerCommission } from './partner-commission.entity';

/**
 * Pre-batch queue for Stream B (signup-batch commissions). One row
 * per qualified user per partner. A user qualifies when they've
 * completed enough exam sessions to have submitted at least
 * `signup_min_completed_answers` (default 40) answers.
 *
 * When a partner has 10 rows with NULL `batched_commission_id`,
 * PartnerCommissionsService.tryCloseBatch pulls them into a single
 * `partner_commissions` row (`type = signup_batch`, 10 user_ids in
 * `batch_user_ids`) and stamps them all with the new commission id.
 *
 * UNIQUE (partner_id, user_id) means the same user cannot count
 * twice toward a partner's batch, even if some manual re-attribution
 * happens later.
 */
@Entity({ name: 'partner_signup_credits' })
export class PartnerSignupCredit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'partner_id', type: 'uuid' })
  partnerId: string;

  @ManyToOne(() => Partner, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'partner_id' })
  partner: Partner;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @CreateDateColumn({ name: 'qualified_at', type: 'timestamptz' })
  qualifiedAt: Date;

  @Column({
    name: 'batched_commission_id',
    type: 'uuid',
    nullable: true,
  })
  batchedCommissionId: string | null;

  @ManyToOne(() => PartnerCommission, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'batched_commission_id' })
  batchedCommission: PartnerCommission | null;
}
