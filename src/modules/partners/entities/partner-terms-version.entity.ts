import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * Immutable versioned commission-terms document. Every partner
 * points at the version they agreed to (partners.agreed_terms_version_id);
 * every commission points at the version that priced it
 * (partner_commissions.terms_version_id). Terms edits INSERT a new
 * row — never UPDATE — so historical commissions stay pinned to the
 * amounts in force when they were earned.
 */
@Entity({ name: 'partner_terms_versions' })
export class PartnerTermsVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'int', unique: true })
  version: number;

  @Column({ type: 'text' })
  title: string;

  @Column({ name: 'body_md', type: 'text' })
  bodyMd: string;

  @Column({ name: 'plus_wassce', type: 'numeric', precision: 10, scale: 2 })
  plusWassce: string;

  @Column({ name: 'plus_novdec', type: 'numeric', precision: 10, scale: 2 })
  plusNovdec: string;

  @Column({ name: 'plus_bece', type: 'numeric', precision: 10, scale: 2 })
  plusBece: string;

  @Column({ name: 'signup_batch_size', type: 'int', default: 10 })
  signupBatchSize: number;

  @Column({
    name: 'signup_batch_amount_ghs',
    type: 'numeric',
    precision: 10,
    scale: 2,
    default: 20.0,
  })
  signupBatchAmountGhs: string;

  @Column({ name: 'signup_min_completed_answers', type: 'int', default: 40 })
  signupMinCompletedAnswers: number;

  @Column({ name: 'answers_bonus_threshold', type: 'int', default: 100 })
  answersBonusThreshold: number;

  @Column({
    name: 'answers_bonus_amount_ghs',
    type: 'numeric',
    precision: 10,
    scale: 2,
    default: 2.0,
  })
  answersBonusAmountGhs: string;

  @Column({ name: 'attribution_window_days', type: 'int', default: 90 })
  attributionWindowDays: number;

  @Column({ name: 'max_fraud_flags_before_block', type: 'int', default: 3 })
  maxFraudFlagsBeforeBlock: number;

  @Column({ name: 'max_appeals', type: 'int', default: 3 })
  maxAppeals: number;

  @Column({
    name: 'effective_from',
    type: 'timestamptz',
    default: () => 'now()',
  })
  effectiveFrom: Date;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by' })
  createdByUser: User | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
