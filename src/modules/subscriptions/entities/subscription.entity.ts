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
  BillingInterval,
  SubscriptionStatus,
} from '../../../common/types/enums';
import { User } from '../../users/entities/user.entity';
import { SubscriptionPlanEntity } from '../plans/entities/subscription-plan.entity';

@Entity({ name: 'subscriptions' })
@Index('idx_subs_user', ['userId', 'status'])
@Index('idx_subs_expiry', ['status', 'expiresAt'])
export class Subscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  /**
   * Which plan this subscription was purchased against. NULL for XP-credited
   * subscriptions — those are granted without a paid plan and use the
   * `status = XP_CREDITED` signal instead.
   */
  @Column({ name: 'plan_id', type: 'uuid', nullable: true })
  planId: string | null;

  @ManyToOne(() => SubscriptionPlanEntity, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'plan_id' })
  plan: SubscriptionPlanEntity | null;

  /** Which cadence the user bought within the plan. NULL for XP credits. */
  @Column({
    name: 'billing_interval',
    type: 'enum',
    enum: BillingInterval,
    nullable: true,
  })
  billingInterval: BillingInterval | null;

  /**
   * Denormalized copy of plan.provider at purchase time. Lets webhook lookups
   * resolve the right provider adapter without a plan join, and survives even
   * if the plan row is later archived.
   */
  @Column({ type: 'text', nullable: true })
  provider: string | null;

  @Column({
    type: 'enum',
    enum: SubscriptionStatus,
    default: SubscriptionStatus.TRIAL,
  })
  status: SubscriptionStatus;

  @Column({ name: 'provider_reference', type: 'text', nullable: true })
  providerReference: string | null;

  @Column({ name: 'provider_subscription_id', type: 'text', nullable: true })
  providerSubscriptionId: string | null;

  @Column({ name: 'provider_customer_id', type: 'text', nullable: true })
  providerCustomerId: string | null;

  @Column({
    name: 'amount_ghs',
    type: 'numeric',
    precision: 10,
    scale: 2,
    nullable: true,
  })
  amountGhs: string | null;

  // v2: subscription granted via XP redemption — points to the redemption row.
  @Column({ name: 'xp_redemption_id', type: 'uuid', nullable: true })
  xpRedemptionId: string | null;

  @Column({ name: 'country_code', type: 'varchar', length: 2, default: 'GH' })
  countryCode: string;

  @Column({ name: 'starts_at', type: 'timestamptz', default: () => 'now()' })
  startsAt: Date;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
