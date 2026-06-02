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
import {
  AccountType,
  ExamType,
  PromoDiscountType,
} from '../../../common/types/enums';
import { User } from '../../users/entities/user.entity';

/**
 * Discount code redeemable at checkout. Schema defined in migration
 * 1860 — this entity mirrors that table.
 *
 * Scope is set via `applicableAccount` + `applicableLevel`:
 *   - Both NULL: code applies to ANY plan.
 *   - account set, level NULL: applies to any plan of that account (e.g. "all Plus plans").
 *   - level set, account NULL: applies to any plan on that level (e.g. "all WASSCE plans").
 *   - Both set: applies only to that exact (account, level) combination.
 */
@Entity({ name: 'promo_codes' })
@Index('promo_codes_active_idx', ['isActive'])
export class PromoCode {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Stored lowercased so redemption is case-insensitive. */
  @Column({ type: 'text', unique: true })
  code: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({
    name: 'discount_type',
    type: 'enum',
    enum: PromoDiscountType,
  })
  discountType: PromoDiscountType;

  @Column({
    name: 'discount_value',
    type: 'numeric',
    precision: 10,
    scale: 2,
  })
  discountValue: string;

  @Column({
    name: 'applicable_account',
    type: 'enum',
    enum: AccountType,
    nullable: true,
  })
  applicableAccount: AccountType | null;

  @Column({
    name: 'applicable_level',
    type: 'enum',
    enum: ExamType,
    nullable: true,
  })
  applicableLevel: ExamType | null;

  @Column({ name: 'max_redemptions', type: 'int', nullable: true })
  maxRedemptions: number | null;

  @Column({ name: 'redeemed_count', type: 'int', default: 0 })
  redeemedCount: number;

  @Column({ name: 'valid_from', type: 'timestamptz', nullable: true })
  validFrom: Date | null;

  @Column({ name: 'valid_until', type: 'timestamptz', nullable: true })
  validUntil: Date | null;

  @Column({ name: 'is_active', type: 'bool', default: true })
  isActive: boolean;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by' })
  createdByUser: User | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
