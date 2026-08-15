import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { SupportTicketMessage } from './support-ticket-message.entity';

export type SupportTicketCategory =
  | 'feedback'
  | 'wrong_question'
  | 'payment'
  | 'general';
export type SupportTicketStatus = 'open' | 'closed';
export type SupportTicketLastReplyBy = 'user' | 'admin';

/**
 * A support conversation between one student and the ops team.
 *
 *   category   — routes triage; also drives the icon on the mobile
 *                list. Adding more categories is a CHECK constraint
 *                change, not a schema-typed enum, so it's cheap.
 *   status     — `open` while ops is expected to reply; `closed` when
 *                ops has resolved. Only admin flips to closed.
 *   related_ticket_number — set when a student opens a follow-up on a
 *                closed ticket ("this continues from BQ-2609-0034").
 *   context    — free-form jsonb for capturing structured evidence at
 *                creation time (question id + snapshot for
 *                wrong_question, payment reference for payment, etc.).
 *   last_reply_by/at — denormalised so the admin queue can order by
 *                'oldest awaiting reply' without a subquery.
 */
@Entity({ name: 'support_tickets' })
@Index('idx_support_tickets_user_id', ['userId'])
@Index('idx_support_tickets_status', ['status'])
@Index('idx_support_tickets_queue', ['status', 'lastReplyAt'])
export class SupportTicket {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'ticket_number', type: 'text', unique: true })
  ticketNumber: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'text' })
  category: SupportTicketCategory;

  @Column({ type: 'text' })
  subject: string;

  @Column({ type: 'text', default: 'open' })
  status: SupportTicketStatus;

  @Column({ name: 'related_ticket_number', type: 'text', nullable: true })
  relatedTicketNumber: string | null;

  @Column({ type: 'jsonb', nullable: true })
  context: Record<string, unknown> | null;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt: Date | null;

  @Column({ name: 'closed_by', type: 'uuid', nullable: true })
  closedBy: string | null;

  @Column({ name: 'closed_reason', type: 'text', nullable: true })
  closedReason: string | null;

  @Column({ name: 'last_reply_at', type: 'timestamptz' })
  lastReplyAt: Date;

  @Column({ name: 'last_reply_by', type: 'text', default: 'user' })
  lastReplyBy: SupportTicketLastReplyBy;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => SupportTicketMessage, (m) => m.ticket)
  messages: SupportTicketMessage[];
}
