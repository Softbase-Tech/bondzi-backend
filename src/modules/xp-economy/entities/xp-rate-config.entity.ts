import {
  Column,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Admin-editable XP reward rates. Every earning event reads its amount from
 * this table — never from constants in code. Admin can zero out or disable any
 * row to instantly suspend that reward.
 */
@Entity({ name: 'xp_rate_config' })
export class XpRateConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'event_key', type: 'text', unique: true })
  eventKey: string;

  @Column({ type: 'text' })
  label: string;

  @Column({ name: 'xp_amount', type: 'int' })
  xpAmount: number;

  @Column({ name: 'is_active', type: 'bool', default: true })
  isActive: boolean;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
