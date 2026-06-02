import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { PromoCode } from './promo-code.entity';
import { User } from '../../users/entities/user.entity';
import { Subscription } from '../../subscriptions/entities/subscription.entity';

/**
 * Append-only ledger of every promo redemption. One row per (code, user)
 * — enforced by a unique index on (promo_code_id, user_id) so the same
 * user can't redeem the same code twice.
 */
@Entity({ name: 'promo_redemptions' })
@Index('promo_redemptions_user_idx', ['userId'])
export class PromoRedemption {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'promo_code_id', type: 'uuid' })
  promoCodeId: string;

  @ManyToOne(() => PromoCode, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'promo_code_id' })
  promoCode: PromoCode;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'subscription_id', type: 'uuid', nullable: true })
  subscriptionId: string | null;

  @ManyToOne(() => Subscription, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'subscription_id' })
  subscription: Subscription | null;

  @Column({
    name: 'discount_amount',
    type: 'numeric',
    precision: 10,
    scale: 2,
  })
  discountAmount: string;

  @Column({ type: 'text' })
  currency: string;

  @CreateDateColumn({ name: 'redeemed_at', type: 'timestamptz' })
  redeemedAt: Date;
}
