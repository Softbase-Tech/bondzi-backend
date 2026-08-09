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

export type EmailSendStatus =
  | 'sent'
  | 'dry_run'
  | 'failed'
  | 'skipped'
  | 'bounced';

@Entity({ name: 'email_sends' })
@Index('idx_email_sends_user_created', ['userId', 'createdAt'])
export class EmailSend {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ type: 'text' })
  event: string;

  @Column({ name: 'to_email', type: 'text' })
  toEmail: string;

  @Column({ name: 'dedup_key', type: 'text', nullable: true, unique: true })
  dedupKey: string | null;

  @Column({ name: 'resend_id', type: 'text', nullable: true })
  resendId: string | null;

  @Column({ type: 'text' })
  status: EmailSendStatus;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
