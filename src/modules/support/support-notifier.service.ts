import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationChannel } from '../../common/types/enums';
import { SupportTicket } from './entities/support-ticket.entity';
import { SupportTicketMessage } from './entities/support-ticket-message.entity';
import { AdminAlertService } from '../mail/admin-alert.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Fires notifications the ticket system owes:
 *
 *   - onTicketCreated → email the ops inbox (ADMIN_ALERT_EMAIL) so
 *     they see the new row without needing to poll the queue.
 *   - onUserReplied   → email ops again so an escalating conversation
 *     stays visible outside the admin panel.
 *   - onAdminReplied  → push + in-app notification to the student on
 *     both the profile bell and their notification centre. Delivered
 *     via NotificationsService which persists the in-app row and
 *     queues the FCM dispatch in one shot.
 *   - onTicketClosed  → push + in-app "your ticket was closed" so the
 *     student sees a hard confirmation and knows to open a new
 *     ticket if the problem recurs.
 *
 * User email is deferred: push + in-app cover it and adding a mail
 * template for each event needs a Resend template push + MailEvent
 * enum expansion. That lands in a follow-up when we see students
 * report they missed a reply.
 *
 * Every path swallows its own transport errors — the caller in
 * SupportTicketsService already wraps in `.catch` so a mail/push
 * outage never poisons a ticket write.
 */
@Injectable()
export class SupportNotifierService {
  private readonly logger = new Logger(SupportNotifierService.name);

  constructor(
    @InjectRepository(SupportTicket)
    private readonly ticketsRepo: Repository<SupportTicket>,
    @InjectRepository(SupportTicketMessage)
    private readonly messagesRepo: Repository<SupportTicketMessage>,
    private readonly adminAlerts: AdminAlertService,
    private readonly notifications: NotificationsService,
  ) {}

  async onTicketCreated(ticketId: string): Promise<void> {
    const t = await this.loadTicketWithUser(ticketId);
    if (!t) return;
    const latest = await this.latestMessage(ticketId);
    const subject = `New ticket ${t.ticketNumber}: ${t.subject}`;
    const body =
      `Category: ${t.category}\n` +
      `From: ${t.user.fullName} <${t.user.email ?? 'no-email'}>\n\n` +
      `${latest?.body ?? ''}\n\n` +
      `Reply in the admin panel: /admin/support/${t.id}`;
    await this.adminAlerts.send(subject, body);
  }

  async onUserReplied(ticketId: string): Promise<void> {
    const t = await this.loadTicketWithUser(ticketId);
    if (!t) return;
    const latest = await this.latestMessage(ticketId);
    const subject = `Reply on ${t.ticketNumber}: ${t.subject}`;
    const body =
      `From: ${t.user.fullName} <${t.user.email ?? 'no-email'}>\n\n` +
      `${latest?.body ?? ''}\n\n` +
      `Reply in the admin panel: /admin/support/${t.id}`;
    await this.adminAlerts.send(subject, body);
  }

  async onAdminReplied(ticketId: string): Promise<void> {
    const t = await this.loadTicketWithUser(ticketId);
    if (!t) return;
    const latest = await this.latestMessage(ticketId);
    const previewBody = (latest?.body ?? '').slice(0, 240);
    await this.notifications
      .send({
        userId: t.userId,
        channel: NotificationChannel.PUSH,
        title: `Reply on ${t.ticketNumber}`,
        body: previewBody || 'Tap to read the reply.',
        data: {
          kind: 'support_reply',
          ticketId: t.id,
          ticketNumber: t.ticketNumber,
          deeplink: `/help/tickets/${t.id}`,
        },
      })
      .catch((err) =>
        this.logger.warn(`notifications support_reply: ${String(err)}`),
      );
  }

  async onTicketClosed(ticketId: string): Promise<void> {
    const t = await this.loadTicketWithUser(ticketId);
    if (!t) return;
    const body =
      `Your ticket "${t.subject}" has been closed.` +
      (t.closedReason ? ` ${t.closedReason}` : '');
    await this.notifications
      .send({
        userId: t.userId,
        channel: NotificationChannel.PUSH,
        title: `Ticket ${t.ticketNumber} closed`,
        body,
        data: {
          kind: 'support_closed',
          ticketId: t.id,
          ticketNumber: t.ticketNumber,
          deeplink: `/help/tickets/${t.id}`,
        },
      })
      .catch((err) =>
        this.logger.warn(`notifications support_closed: ${String(err)}`),
      );
  }

  private async loadTicketWithUser(id: string) {
    return this.ticketsRepo.findOne({
      where: { id },
      relations: { user: true },
    });
  }

  private async latestMessage(ticketId: string) {
    return this.messagesRepo.findOne({
      where: { ticketId },
      order: { createdAt: 'DESC' },
    });
  }
}
