import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../../users/entities/user.entity';
import { numericTransformer } from '../../../../common/utils/numeric.transformer';
import {
  AccountType,
  ExamType,
  PaymentKind,
} from '../../../../common/types/enums';

/**
 * A single subscription product (e.g. "Bondzi Pro GH"). Each row bundles
 * all three billing cadences (monthly / six-month / annual) with their prices,
 * durations, and provider-side plan codes.
 *
 * Versioning:
 *   A price or duration change inserts a NEW row and flips the previous row
 *   `is_active = false`. `parent_plan_id` points at the immediate predecessor,
 *   so the admin UI can render a version chain ("v3 current, v2, v1"). Old
 *   rows stay visible so existing subscribers (who still renew against the
 *   old provider plan codes) keep their historical plan record queryable.
 *
 * Provider immutability:
 *   Paystack / Stripe / Flutterwave plan objects are immutable. A price
 *   change creates a new provider plan; any cadence whose price did NOT
 *   change carries forward the old code, saving an API call.
 */
@Entity({ name: 'subscription_plan' })
@Index('idx_plan_country_active', ['countryCode', 'isActive'])
@Index('idx_plan_parent', ['parentPlanId'])
@Index('idx_plan_account_level_active', ['account', 'level', 'isActive'])
export class SubscriptionPlanEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  name: string;

  /**
   * Plan grade. Determines what content the holder can access:
   *   - `plus`: lifetime access to past + practice questions + AI explanations
   *     for the plan's `level`.
   *   - `pro`:  everything in plus + curated AI tests + analytics for the
   *     plan's `level`.
   * (Free is never a plan row — it's the absence of any active entitlement.)
   */
  @Column({
    type: 'enum',
    enum: AccountType,
  })
  account: AccountType;

  /**
   * Which exam-platform the plan unlocks: `bece`, `wassce` or `novdec`.
   * Per-level pricing means a user must purchase separately for each level
   * they want to study under.
   */
  @Column({
    type: 'enum',
    enum: ExamType,
  })
  level: ExamType;

  /**
   * `one_time` plans are charged once and grant lifetime access (subscription
   * row carries `expires_at = NULL`). `recurring` plans use Paystack's
   * subscription primitive and renew on each billing cycle.
   */
  @Column({
    name: 'payment_kind',
    type: 'enum',
    enum: PaymentKind,
  })
  paymentKind: PaymentKind;

  /**
   * VAT (or VAT-equivalent levy stack) baked into the displayed price. Stored
   * inclusively: when this is `15.00`, a `monthlyPrice` of 200.00 means the
   * student pays 200.00 at checkout and the receipt breaks it down as
   * ~173.91 net + ~26.09 VAT. `0` for tax-exempt or non-GH plans.
   */
  @Column({
    name: 'vat_rate_pct',
    type: 'numeric',
    precision: 5,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  vatRatePct: number;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'country_code', type: 'text' })
  countryCode: string;

  @Column({ type: 'text' })
  currency: string;

  /** Machine name of the PaymentProvider handling this plan ('paystack', ...). */
  @Column({ type: 'text' })
  provider: string;

  @Column({
    name: 'monthly_price',
    type: 'numeric',
    precision: 10,
    scale: 2,
    transformer: numericTransformer,
  })
  monthlyPrice: number;

  @Column({
    name: 'six_month_price',
    type: 'numeric',
    precision: 10,
    scale: 2,
    transformer: numericTransformer,
  })
  sixMonthPrice: number;

  @Column({
    name: 'annual_price',
    type: 'numeric',
    precision: 10,
    scale: 2,
    transformer: numericTransformer,
  })
  annualPrice: number;

  @Column({ name: 'monthly_duration_days', type: 'int', default: 30 })
  monthlyDurationDays: number;

  @Column({ name: 'six_month_duration_days', type: 'int', default: 180 })
  sixMonthDurationDays: number;

  @Column({ name: 'annual_duration_days', type: 'int', default: 365 })
  annualDurationDays: number;

  @Column({ name: 'provider_plan_monthly', type: 'text', nullable: true })
  providerPlanMonthly: string | null;

  @Column({ name: 'provider_plan_six_month', type: 'text', nullable: true })
  providerPlanSixMonth: string | null;

  @Column({ name: 'provider_plan_annual', type: 'text', nullable: true })
  providerPlanAnnual: string | null;

  @Column({ name: 'is_active', type: 'bool', default: true })
  isActive: boolean;

  @Column({ name: 'is_default', type: 'bool', default: false })
  isDefault: boolean;

  @Column({ type: 'int', default: 1 })
  version: number;

  @Column({ name: 'parent_plan_id', type: 'uuid', nullable: true })
  parentPlanId: string | null;

  @ManyToOne(() => SubscriptionPlanEntity, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'parent_plan_id' })
  parentPlan: SubscriptionPlanEntity | null;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by' })
  createdByUser: User | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  /**
   * Version-bump grace period (#73). When a price changes, the previous
   * plan row gets `archive_at = NOW() + CHECKOUT_GRACE_HOURS`. Effects:
   *   - Public listing hides plans with archive_at < NOW().
   *   - Webhook resolution still finds them by provider_plan_code so
   *     a checkout URL that was created before the bump can still
   *     complete and process correctly.
   *   - A scheduled cleanup eventually flips deleted_at to tombstone
   *     the row.
   * NULL means "no scheduled archive" — i.e. the plan is current.
   */
  @Column({ name: 'archive_at', type: 'timestamptz', nullable: true })
  archiveAt: Date | null;

  // Hard "archived" timestamp distinct from is_active=false. is_active=false
  // means "don't surface to new subscribers but the row is still alive
  // (existing subscribers + open authorizationUrls still resolve)";
  // deleted_at means "the plan is truly removed and should not appear
  // anywhere except in audit forensics." See plans.service.ts grace-
  // period flow for the staged transition.
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
