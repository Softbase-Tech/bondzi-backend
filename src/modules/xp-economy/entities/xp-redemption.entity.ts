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
 * A single redemption event — user traded XP for subscription days. One row
 * maps 1:1 to a Subscription(plan=xp_credit). Audit trail.
 */
@Entity({ name: 'xp_redemptions' })
export class XpRedemption {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'tier_key', type: 'text' })
  tierKey: string;

  @Column({ name: 'xp_spent', type: 'int' })
  xpSpent: number;

  @Column({ name: 'credit_days', type: 'int' })
  creditDays: number;

  @CreateDateColumn({ name: 'applied_at', type: 'timestamptz' })
  appliedAt: Date;
}
