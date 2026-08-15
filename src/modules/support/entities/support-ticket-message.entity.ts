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
import { SupportTicket } from './support-ticket.entity';

export type SupportMessageSenderRole = 'user' | 'admin' | 'system';

/**
 * Attachment metadata stored inline on a message. Fully self-contained
 * so the render doesn't need a join to resolve the URL — that also
 * means adding fields (thumbnail, blurhash) later is a jsonb write,
 * not a migration.
 *
 * `sizeBytes` is honest storage so the mobile UI can label images
 * "1.2 MB" instead of loading them to measure. `mime` gates whether
 * to render as an image or a generic file chip.
 */
export interface SupportTicketAttachment {
  url: string;
  mime: string;
  sizeBytes: number;
  originalFilename?: string;
}

/**
 * One message in a support-ticket thread. `sender_role` is
 * denormalised off the users table so a queue that renders "last
 * message from admin/user" doesn't need to hydrate the user row —
 * and so `system` messages (e.g., "ticket closed") have a role that
 * doesn't rely on a specific user.
 *
 * `sender_id` is nullable because system messages have no author and
 * because ON DELETE SET NULL keeps historical threads readable after
 * a user is anonymised via the account-deletion flow.
 */
@Entity({ name: 'support_ticket_messages' })
@Index('idx_support_ticket_messages_ticket_id', ['ticketId', 'createdAt'])
export class SupportTicketMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'ticket_id', type: 'uuid' })
  ticketId: string;

  @ManyToOne(() => SupportTicket, (t) => t.messages, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticket_id' })
  ticket: SupportTicket;

  @Column({ name: 'sender_id', type: 'uuid', nullable: true })
  senderId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'sender_id' })
  sender: User | null;

  @Column({ name: 'sender_role', type: 'text' })
  senderRole: SupportMessageSenderRole;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  attachments: SupportTicketAttachment[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
