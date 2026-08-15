import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { SupportTicket } from './entities/support-ticket.entity';
import {
  SupportTicketMessage,
  SupportTicketAttachment,
} from './entities/support-ticket-message.entity';
import { User } from '../users/entities/user.entity';
import type {
  CreateMessageDto,
  CreateTicketDto,
  CloseTicketDto,
  AttachmentDto,
} from './dto/create-ticket.dto';
import { SupportNotifierService } from './support-notifier.service';

export interface SupportTicketRow {
  id: string;
  ticketNumber: string;
  category: SupportTicket['category'];
  subject: string;
  status: SupportTicket['status'];
  relatedTicketNumber: string | null;
  lastReplyAt: string;
  lastReplyBy: SupportTicket['lastReplyBy'];
  closedAt: string | null;
  createdAt: string;
  /** Included on admin queue responses, omitted on user list. */
  user?: {
    id: string;
    fullName: string;
    email: string | null;
    username: string | null;
  };
  /** Message count for the summary row. */
  messageCount: number;
  /** First 140 chars of the last message, for the queue preview. */
  preview: string;
}

export interface SupportTicketDetail extends SupportTicketRow {
  messages: SupportTicketMessageRow[];
  context: Record<string, unknown> | null;
}

export interface SupportTicketMessageRow {
  id: string;
  senderRole: SupportTicketMessage['senderRole'];
  senderId: string | null;
  senderName: string | null;
  body: string;
  attachments: SupportTicketAttachment[];
  createdAt: string;
}

/**
 * The engine behind /support/tickets and /admin/support/tickets.
 *
 * Invariants worth stating in one place because they're spread across
 * the methods:
 *
 *   1. A user can only touch their own tickets. `assertOwner` guards
 *      every user-facing method; the admin controller mounts under
 *      RolesGuard so the same methods are safe to expose.
 *
 *   2. Only admins can close a ticket. Users can't reopen either —
 *      re-opening is done by creating a NEW ticket that references
 *      the old one via `relatedTicketNumber`. Enforced by dedicated
 *      methods (there's no `changeStatus` that a user could hit).
 *
 *   3. A closed ticket accepts NO messages from anyone. If the ops
 *      team needs to add a note to a closed thread they must reopen
 *      it explicitly (admin `reopen` — added when we need it, not
 *      pre-emptively).
 *
 *   4. Ticket numbers are BQ-YYMM-NNNN. NNNN is a nextval from
 *      `support_tickets_number_seq`. The sequence is global (not
 *      per-month), but numbers within any given month land in a
 *      contiguous-ish range so they still feel dense to students.
 *
 *   5. Notifications fire post-commit via SupportNotifierService.
 *      A notification-side failure never poisons the ticket write.
 */
@Injectable()
export class SupportTicketsService {
  private readonly logger = new Logger(SupportTicketsService.name);

  constructor(
    @InjectRepository(SupportTicket)
    private readonly ticketsRepo: Repository<SupportTicket>,
    @InjectRepository(SupportTicketMessage)
    private readonly messagesRepo: Repository<SupportTicketMessage>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly notifier: SupportNotifierService,
  ) {}

  // ==================================================================
  // Reads — user-scoped
  // ==================================================================

  async listForUser(userId: string): Promise<SupportTicketRow[]> {
    const rows = await this.ticketsRepo.find({
      where: { userId },
      order: { lastReplyAt: 'DESC' },
      take: 100,
    });
    if (rows.length === 0) return [];
    const previews = await this.previewFor(rows.map((r) => r.id));
    return rows.map((t) => this.toRow(t, previews));
  }

  async getForUser(
    userId: string,
    ticketId: string,
  ): Promise<SupportTicketDetail> {
    const ticket = await this.ticketsRepo.findOne({
      where: { id: ticketId },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    this.assertOwner(ticket, userId);
    return this.buildDetail(ticket);
  }

  // ==================================================================
  // Writes — user-scoped
  // ==================================================================

  async createForUser(
    userId: string,
    dto: CreateTicketDto,
  ): Promise<SupportTicketDetail> {
    // If the user references a prior ticket, verify they actually own
    // that one — otherwise ops loses signal (someone else's ticket
    // number popping up as "related" is misleading).
    if (dto.relatedTicketNumber) {
      const parent = await this.ticketsRepo.findOne({
        where: {
          ticketNumber: dto.relatedTicketNumber.toUpperCase(),
        },
      });
      if (!parent || parent.userId !== userId) {
        throw new BadRequestException(
          "The referenced ticket doesn't exist on your account.",
        );
      }
    }

    const attachments = normaliseAttachments(dto.attachments);
    const ticketNumber = await this.nextTicketNumber();
    const nowIso = new Date();

    const saved = await this.dataSource.transaction(async (em) => {
      const ticket = em.getRepository(SupportTicket).create({
        ticketNumber,
        userId,
        category: dto.category,
        subject: dto.subject.trim(),
        status: 'open',
        relatedTicketNumber: dto.relatedTicketNumber?.toUpperCase() ?? null,
        context: dto.context ?? null,
        lastReplyAt: nowIso,
        lastReplyBy: 'user',
      });
      const persisted = await em.getRepository(SupportTicket).save(ticket);
      await em.getRepository(SupportTicketMessage).save(
        em.getRepository(SupportTicketMessage).create({
          ticketId: persisted.id,
          senderId: userId,
          senderRole: 'user',
          body: dto.body.trim(),
          attachments,
        }),
      );
      return persisted;
    });

    // Post-commit: ping ops so they see the new ticket.
    void this.notifier
      .onTicketCreated(saved.id)
      .catch((err) => this.logger.warn(`notifier onCreated: ${String(err)}`));

    return this.buildDetail(saved);
  }

  async replyAsUser(
    userId: string,
    ticketId: string,
    dto: CreateMessageDto,
  ): Promise<SupportTicketDetail> {
    const ticket = await this.ticketsRepo.findOne({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Ticket not found');
    this.assertOwner(ticket, userId);
    if (ticket.status === 'closed') {
      throw new BadRequestException(
        "This ticket is closed. Open a new one and reference it with '" +
          ticket.ticketNumber +
          "'.",
      );
    }
    const attachments = normaliseAttachments(dto.attachments);
    await this.dataSource.transaction(async (em) => {
      await em.getRepository(SupportTicketMessage).save(
        em.getRepository(SupportTicketMessage).create({
          ticketId: ticket.id,
          senderId: userId,
          senderRole: 'user',
          body: dto.body.trim(),
          attachments,
        }),
      );
      await em.getRepository(SupportTicket).update(
        { id: ticket.id },
        { lastReplyAt: new Date(), lastReplyBy: 'user' },
      );
    });
    void this.notifier
      .onUserReplied(ticket.id)
      .catch((err) => this.logger.warn(`notifier onUserReplied: ${String(err)}`));
    return this.buildDetail(
      (await this.ticketsRepo.findOne({ where: { id: ticket.id } }))!,
    );
  }

  // ==================================================================
  // Reads — admin
  // ==================================================================

  async listForAdmin(filters: {
    status?: SupportTicket['status'];
    category?: SupportTicket['category'];
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<{ items: SupportTicketRow[]; total: number }> {
    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(100, Math.max(1, filters.limit ?? 25));

    const qb = this.ticketsRepo
      .createQueryBuilder('t')
      .leftJoinAndSelect('t.user', 'u');
    if (filters.status) qb.andWhere('t.status = :s', { s: filters.status });
    if (filters.category)
      qb.andWhere('t.category = :c', { c: filters.category });
    if (filters.search) {
      qb.andWhere(
        '(t.ticket_number ILIKE :q OR t.subject ILIKE :q OR u.email ILIKE :q OR u.full_name ILIKE :q)',
        { q: `%${filters.search}%` },
      );
    }
    qb.orderBy(
      // Open first, then oldest-last-reply so ops always sees the
      // stalest queue at the top.
      `CASE WHEN t.status = 'open' THEN 0 ELSE 1 END`,
      'ASC',
    ).addOrderBy('t.last_reply_at', 'ASC');

    const [rows, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    const previews = await this.previewFor(rows.map((r) => r.id));

    return {
      items: rows.map((t) => this.toRow(t, previews, /* includeUser */ true)),
      total,
    };
  }

  async getForAdmin(ticketId: string): Promise<SupportTicketDetail> {
    const ticket = await this.ticketsRepo.findOne({
      where: { id: ticketId },
      relations: { user: true },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    return this.buildDetail(ticket, /* includeUser */ true);
  }

  // ==================================================================
  // Writes — admin
  // ==================================================================

  async replyAsAdmin(
    adminUserId: string,
    ticketId: string,
    dto: CreateMessageDto,
  ): Promise<SupportTicketDetail> {
    const ticket = await this.ticketsRepo.findOne({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Ticket not found');
    if (ticket.status === 'closed') {
      throw new BadRequestException(
        'Ticket is closed. Reopen it before replying.',
      );
    }
    const attachments = normaliseAttachments(dto.attachments);
    await this.dataSource.transaction(async (em) => {
      await em.getRepository(SupportTicketMessage).save(
        em.getRepository(SupportTicketMessage).create({
          ticketId: ticket.id,
          senderId: adminUserId,
          senderRole: 'admin',
          body: dto.body.trim(),
          attachments,
        }),
      );
      await em.getRepository(SupportTicket).update(
        { id: ticket.id },
        { lastReplyAt: new Date(), lastReplyBy: 'admin' },
      );
    });
    void this.notifier
      .onAdminReplied(ticket.id)
      .catch((err) => this.logger.warn(`notifier onAdminReplied: ${String(err)}`));
    return this.buildDetail(
      (await this.ticketsRepo.findOne({ where: { id: ticket.id } }))!,
      true,
    );
  }

  async closeAsAdmin(
    adminUserId: string,
    ticketId: string,
    dto: CloseTicketDto,
  ): Promise<SupportTicketDetail> {
    const ticket = await this.ticketsRepo.findOne({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Ticket not found');
    if (ticket.status === 'closed') {
      // Idempotent — return the current state without a re-notify.
      return this.buildDetail(ticket, true);
    }
    const now = new Date();
    await this.dataSource.transaction(async (em) => {
      await em.getRepository(SupportTicket).update(
        { id: ticket.id },
        {
          status: 'closed',
          closedAt: now,
          closedBy: adminUserId,
          closedReason: dto.reason?.trim() ?? null,
        },
      );
      // Drop a system message so the thread carries a visible close
      // marker; users see this instead of a silent status flip.
      const bodyParts = ['This ticket has been closed.'];
      if (dto.reason?.trim()) bodyParts.push(dto.reason.trim());
      await em.getRepository(SupportTicketMessage).save(
        em.getRepository(SupportTicketMessage).create({
          ticketId: ticket.id,
          senderId: adminUserId,
          senderRole: 'system',
          body: bodyParts.join('\n\n'),
          attachments: [],
        }),
      );
    });
    void this.notifier
      .onTicketClosed(ticket.id)
      .catch((err) => this.logger.warn(`notifier onClosed: ${String(err)}`));
    return this.buildDetail(
      (await this.ticketsRepo.findOne({
        where: { id: ticket.id },
        relations: { user: true },
      }))!,
      true,
    );
  }

  // ==================================================================
  // Helpers
  // ==================================================================

  private assertOwner(ticket: SupportTicket, userId: string): void {
    if (ticket.userId !== userId) {
      throw new ForbiddenException('This ticket does not belong to you.');
    }
  }

  private async nextTicketNumber(): Promise<string> {
    // BQ-YYMM-NNNN — the YYMM anchors the number to a month for
    // human readability; the NNNN is a global sequence so density
    // and uniqueness are both handled by Postgres.
    const [{ nextval }] = await this.dataSource.query<{ nextval: string }[]>(
      `SELECT nextval('support_tickets_number_seq')::text as nextval`,
    );
    const now = new Date();
    const yy = String(now.getUTCFullYear()).slice(-2);
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `BQ-${yy}${mm}-${nextval.padStart(4, '0')}`;
  }

  private async previewFor(
    ticketIds: string[],
  ): Promise<Map<string, { preview: string; count: number }>> {
    if (ticketIds.length === 0) return new Map();
    // Two SELECTs is fine at our volume — one for count, one for
    // the newest body per ticket. Both are indexed on ticket_id.
    const counts = await this.messagesRepo
      .createQueryBuilder('m')
      .select('m.ticket_id', 'ticketId')
      .addSelect('COUNT(m.id)', 'count')
      .where({ ticketId: In(ticketIds) })
      .groupBy('m.ticket_id')
      .getRawMany<{ ticketId: string; count: string }>();
    const latest = await this.dataSource.query<
      { ticket_id: string; body: string }[]
    >(
      `SELECT DISTINCT ON (ticket_id) ticket_id, body
       FROM support_ticket_messages
       WHERE ticket_id = ANY($1::uuid[])
       ORDER BY ticket_id, created_at DESC`,
      [ticketIds],
    );
    const out = new Map<string, { preview: string; count: number }>();
    for (const c of counts) {
      out.set(c.ticketId, { preview: '', count: Number(c.count) });
    }
    for (const l of latest) {
      const prev = out.get(l.ticket_id) ?? { preview: '', count: 0 };
      out.set(l.ticket_id, {
        preview: (l.body ?? '').slice(0, 140),
        count: prev.count,
      });
    }
    return out;
  }

  private async buildDetail(
    ticket: SupportTicket,
    includeUser = false,
  ): Promise<SupportTicketDetail> {
    const messages = await this.messagesRepo.find({
      where: { ticketId: ticket.id },
      relations: { sender: true },
      order: { createdAt: 'ASC' },
    });
    const previews = await this.previewFor([ticket.id]);
    const base = this.toRow(ticket, previews, includeUser);
    return {
      ...base,
      context: ticket.context,
      messages: messages.map((m) => ({
        id: m.id,
        senderRole: m.senderRole,
        senderId: m.senderId,
        senderName: m.sender?.fullName ?? null,
        body: m.body,
        attachments: m.attachments,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  private toRow(
    t: SupportTicket,
    previews: Map<string, { preview: string; count: number }>,
    includeUser = false,
  ): SupportTicketRow {
    const p = previews.get(t.id) ?? { preview: '', count: 0 };
    return {
      id: t.id,
      ticketNumber: t.ticketNumber,
      category: t.category,
      subject: t.subject,
      status: t.status,
      relatedTicketNumber: t.relatedTicketNumber,
      lastReplyAt: t.lastReplyAt.toISOString(),
      lastReplyBy: t.lastReplyBy,
      closedAt: t.closedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
      messageCount: p.count,
      preview: p.preview,
      ...(includeUser && t.user
        ? {
            user: {
              id: t.user.id,
              fullName: t.user.fullName,
              email: t.user.email,
              username: t.user.username,
            },
          }
        : {}),
    };
  }
}

/**
 * Ceiling attachment count + strip any keys the DTO validator hasn't
 * whitelisted (defence in depth against a caller that bypasses the
 * class-validator pipe in a follow-up refactor).
 */
function normaliseAttachments(
  input: AttachmentDto[] | undefined,
): SupportTicketAttachment[] {
  if (!input || input.length === 0) return [];
  return input.slice(0, 3).map((a) => ({
    url: a.url,
    mime: a.mime,
    sizeBytes: a.sizeBytes,
    originalFilename: a.originalFilename,
  }));
}
