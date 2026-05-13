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
 * Immutable ledger of XP movements. Every awardXp and redeemXp call writes a
 * row here. Positive amounts = credits; negative spendable_xp = redemption.
 * level_xp is non-negative by construction — we never deduct lifetime XP.
 */
@Entity({ name: 'xp_transactions' })
@Index('idx_xp_tx_user', ['userId', 'createdAt'])
export class XpTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  // Matches xp_rate_config.event_key for earnings; 'redemption' for XP spends.
  @Column({ name: 'event_key', type: 'text' })
  eventKey: string;

  @Column({ name: 'level_xp', type: 'int', default: 0 })
  levelXp: number;

  @Column({ name: 'spendable_xp', type: 'int', default: 0 })
  spendableXp: number;

  // Opaque ref to the triggering entity — exam_id, referral_id, winner_id, etc.
  @Column({ name: 'reference_id', type: 'uuid', nullable: true })
  referenceId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
