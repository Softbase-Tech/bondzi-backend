import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { SupportTicket } from './support-ticket.entity';
import { SupportTicketMessage } from './support-ticket-message.entity';

/**
 * Bytes for a support-ticket attachment. Uploaded first (no ticket
 * yet) and later linked to a message when the student hits Send. If
 * they abandon the compose the row sits orphaned; a follow-up cron
 * will prune those on a 24h TTL.
 */
@Entity({ name: 'support_ticket_attachments' })
export class SupportTicketAttachmentEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'ticket_id', type: 'uuid', nullable: true })
  ticketId: string | null;

  @ManyToOne(() => SupportTicket, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'ticket_id' })
  ticket: SupportTicket | null;

  @Column({ name: 'message_id', type: 'uuid', nullable: true })
  messageId: string | null;

  @ManyToOne(() => SupportTicketMessage, {
    onDelete: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'message_id' })
  message: SupportTicketMessage | null;

  @Column({ type: 'text' })
  mime: string;

  @Column({ name: 'size_bytes', type: 'int' })
  sizeBytes: number;

  @Column({ type: 'text' })
  filename: string;

  @Column({ type: 'bytea' })
  bytes: Buffer;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
