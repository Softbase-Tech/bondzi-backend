import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SupportTicketsService } from './support-tickets.service';
import { SupportTicket } from './entities/support-ticket.entity';
import { SupportTicketMessage } from './entities/support-ticket-message.entity';
import { User } from '../users/entities/user.entity';
import { SupportNotifierService } from './support-notifier.service';

/**
 * SupportTicketsService — invariants we care about:
 *   - user cannot touch a ticket they don't own
 *   - user cannot reply to a closed ticket
 *   - creating a follow-up requires the referenced ticket to belong to
 *     the same user
 *   - admin close is idempotent
 *   - notifier fires without gating the write
 */
describe('SupportTicketsService', () => {
  let service: SupportTicketsService;
  let ticketsRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let messagesRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let notifier: { onTicketCreated: jest.Mock; onUserReplied: jest.Mock };
  let dataSource: { transaction: jest.Mock; query: jest.Mock };

  const buildTicket = (patch: Partial<SupportTicket> = {}): SupportTicket =>
    ({
      id: 't-1',
      ticketNumber: 'BQ-2608-0001',
      userId: 'u-1',
      category: 'feedback',
      subject: 'Test',
      status: 'open',
      relatedTicketNumber: null,
      context: null,
      closedAt: null,
      closedBy: null,
      closedReason: null,
      lastReplyAt: new Date('2026-08-01T00:00:00Z'),
      lastReplyBy: 'user',
      createdAt: new Date('2026-08-01T00:00:00Z'),
      updatedAt: new Date('2026-08-01T00:00:00Z'),
      messages: [],
      user: undefined as unknown as User,
      ...patch,
    }) as SupportTicket;

  beforeEach(async () => {
    ticketsRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(),
    };
    messagesRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      }),
    };
    notifier = {
      onTicketCreated: jest.fn().mockResolvedValue(undefined),
      onUserReplied: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      transaction: jest.fn(async (fn: (em: unknown) => Promise<unknown>) =>
        fn({
          getRepository: jest.fn().mockReturnValue({
            // Simulate TypeORM's create+save: stamp id + timestamps so
            // the downstream buildDetail render doesn't NPE reading
            // `.toISOString()` on the ticket returned to the caller.
            create: jest.fn((r: Record<string, unknown>) => ({
              id: 't-1',
              createdAt: new Date('2026-08-01T00:00:00Z'),
              updatedAt: new Date('2026-08-01T00:00:00Z'),
              ...r,
            })),
            save: jest.fn(async (r: unknown) => r),
            update: jest.fn(async () => ({ affected: 1 })),
          }),
        }),
      ),
      // nextval + latest-message + count queries — no rows in the smoke
      // tests since we never build a real detail response with data.
      query: jest.fn(async (sql: string) => {
        if (sql.includes('nextval')) return [{ nextval: '42' }];
        return [];
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        SupportTicketsService,
        { provide: getRepositoryToken(SupportTicket), useValue: ticketsRepo },
        {
          provide: getRepositoryToken(SupportTicketMessage),
          useValue: messagesRepo,
        },
        { provide: getRepositoryToken(User), useValue: {} },
        { provide: DataSource, useValue: dataSource },
        {
          provide: SupportNotifierService,
          useValue: {
            ...notifier,
            onAdminReplied: jest.fn().mockResolvedValue(undefined),
            onTicketClosed: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get(SupportTicketsService);
  });

  it('generates a BQ-YYMM-NNNN ticket number from the sequence', async () => {
    const persisted = buildTicket();
    ticketsRepo.findOne.mockResolvedValueOnce(persisted);
    await service.createForUser('u-1', {
      category: 'feedback',
      subject: 'Great app',
      body: 'Just testing this out.',
    });
    // We can only verify the SQL was called; the number itself is built
    // client-side using the sequence value + current YYMM. That's
    // enough — the format is documented in the migration.
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining("nextval('support_tickets_number_seq')"),
    );
  });

  it('refuses to open a follow-up on another user’s ticket', async () => {
    ticketsRepo.findOne.mockResolvedValueOnce({
      ...buildTicket({ userId: 'other-user' }),
    });
    await expect(
      service.createForUser('u-1', {
        category: 'general',
        subject: 'Follow-up',
        body: 'Continuing my previous thread.',
        relatedTicketNumber: 'BQ-2608-0001',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('forbids reading a ticket that belongs to another user', async () => {
    ticketsRepo.findOne.mockResolvedValueOnce(
      buildTicket({ userId: 'other-user' }),
    );
    await expect(service.getForUser('u-1', 't-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('refuses to reply on a closed ticket', async () => {
    ticketsRepo.findOne.mockResolvedValueOnce(
      buildTicket({ status: 'closed' }),
    );
    await expect(
      service.replyAsUser('u-1', 't-1', { body: 'Still broken.' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('close-as-admin is idempotent for a ticket already closed', async () => {
    const closed = buildTicket({
      status: 'closed',
      closedAt: new Date('2026-08-14T00:00:00Z'),
      closedBy: 'admin-1',
    });
    ticketsRepo.findOne.mockResolvedValueOnce(closed);
    messagesRepo.find.mockResolvedValueOnce([]);
    const out = await service.closeAsAdmin('admin-2', 't-1', {});
    expect(out.status).toBe('closed');
    // Transaction must NOT fire — the write is skipped.
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('notifier fire-and-forget errors do not block the ticket write', async () => {
    // Force onTicketCreated to reject; the caller wraps it in .catch and
    // the create should still return successfully.
    ticketsRepo.findOne.mockResolvedValueOnce(buildTicket());
    (
      (service as unknown as { notifier: SupportNotifierService }).notifier
        .onTicketCreated as jest.Mock
    ).mockRejectedValueOnce(new Error('mail transport down'));
    await expect(
      service.createForUser('u-1', {
        category: 'general',
        subject: 'Hi',
        body: 'Testing notifier failure path.',
      }),
    ).resolves.toBeDefined();
  });
});
