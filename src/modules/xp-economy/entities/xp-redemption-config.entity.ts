import {
  Column,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Admin-editable XP redemption tiers. Each tier trades a fixed amount of
 * spendable XP for a fixed number of subscription days.
 */
@Entity({ name: 'xp_redemption_config' })
export class XpRedemptionConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tier_key', type: 'text', unique: true })
  tierKey: string;

  @Column({ type: 'text' })
  label: string;

  @Column({ name: 'xp_cost', type: 'int' })
  xpCost: number;

  @Column({ name: 'credit_days', type: 'int' })
  creditDays: number;

  @Column({ name: 'is_active', type: 'bool', default: true })
  isActive: boolean;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
