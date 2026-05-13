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
 * v2 referral event — one row per referral. Two-step XP reward:
 *   1. signup_xp_issued: awarded immediately on registration with a valid code.
 *   2. qualify_xp_issued: awarded once the referred user answers 10 questions.
 */
@Entity({ name: 'referral_events' })
@Index('idx_referral_referrer', ['referrerId'])
@Index('idx_referral_referred', ['referredId'])
export class ReferralEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'referrer_id', type: 'uuid' })
  referrerId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'referrer_id' })
  referrer: User;

  @Column({ name: 'referred_id', type: 'uuid' })
  referredId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'referred_id' })
  referred: User;

  @Column({ name: 'referral_code', type: 'text' })
  referralCode: string;

  @Column({ name: 'signup_xp_issued', type: 'bool', default: false })
  signupXpIssued: boolean;

  @Column({ name: 'qualify_xp_issued', type: 'bool', default: false })
  qualifyXpIssued: boolean;

  @Column({ name: 'qualified_at', type: 'timestamptz', nullable: true })
  qualifiedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
