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
  AccountDeletionReason,
  AccountDeletionStatus,
} from '../../../common/types/enums';
import { User } from '../../users/entities/user.entity';

/**
 * One row per account-deletion request/schedule. See the
 * 2080000000000-AccountDeletions migration for the full contract.
 */
@Entity({ name: 'account_deletions' })
@Index('idx_account_deletions_status_due', ['status', 'deleteAfter'])
export class AccountDeletion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ type: 'enum', enum: AccountDeletionReason })
  reason: AccountDeletionReason;

  @Column({
    type: 'enum',
    enum: AccountDeletionStatus,
    default: AccountDeletionStatus.SCHEDULED,
  })
  status: AccountDeletionStatus;

  /** When the account is purged if the user never returns. */
  @Column({ name: 'delete_after', type: 'timestamptz' })
  deleteAfter: Date;

  /**
   * Snapshot of `users.last_active_at` when this row was scheduled. A
   * later `last_active_at` means the user came back → the sweep cancels.
   */
  @Column({ name: 'reference_active_at', type: 'timestamptz', nullable: true })
  referenceActiveAt: Date | null;

  /** T-14 warning email sent. NULL until sent. */
  @Column({ name: 'warned_first_at', type: 'timestamptz', nullable: true })
  warnedFirstAt: Date | null;

  /** T-7 warning email sent. NULL until sent. */
  @Column({ name: 'warned_final_at', type: 'timestamptz', nullable: true })
  warnedFinalAt: Date | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
