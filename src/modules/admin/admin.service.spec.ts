import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdminService } from './admin.service';
import { User } from '../users/entities/user.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { Exam } from '../exams/entities/exam.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import { AiUsageLog } from '../ai/entities/ai-usage-log.entity';
import { QuestionFlag } from '../questions/entities/question-flag.entity';
import { Question } from '../questions/entities/question.entity';
import { AuditLog } from './entities/audit-log.entity';
import { XpTransaction } from '../xp-economy/entities/xp-transaction.entity';
import { XpRedemption } from '../xp-economy/entities/xp-redemption.entity';
import { ReferralEvent } from '../referrals/entities/referral-event.entity';
import { PmTestQuestion } from '../pm-test/entities/pm-test-question.entity';
import { Winner } from '../leaderboard/entities/winner.entity';

/**
 * AdminService is mostly admin-only read paths + a handful of write paths
 * that need audit-log coverage. Tests pin:
 *   - banUser / resolveFlag throw NotFound on unknown ids
 *   - banUser flips isActive + writes the audit row
 *   - resolveFlag stamps resolvedBy / resolvedAt + writes the audit row
 *   - getUser fans out (subs, exams count, ai usage) in a single call
 *   - listAudit / listUsers honour pagination defaults and never exceed the cap
 */

describe('AdminService', () => {
  let service: AdminService;
  let usersRepo: {
    findOne: jest.Mock;
    save: jest.Mock;
    findAndCount: jest.Mock;
  };
  let subsRepo: { find: jest.Mock; findAndCount: jest.Mock };
  let examsRepo: { count: jest.Mock };
  let answersRepo: Record<string, unknown>;
  let aiRepo: { createQueryBuilder: jest.Mock };
  let flagsRepo: {
    findOne: jest.Mock;
    save: jest.Mock;
    findAndCount: jest.Mock;
  };
  let questionsRepo: Record<string, unknown>;
  let auditRepo: {
    create: jest.Mock;
    save: jest.Mock;
    findAndCount: jest.Mock;
  };
  let xpTxRepo: Record<string, unknown>;
  let xpRedemptionRepo: Record<string, unknown>;
  let referralsRepo: Record<string, unknown>;
  let pmTestRepo: Record<string, unknown>;
  let winnersRepo: Record<string, unknown>;

  beforeEach(async () => {
    usersRepo = {
      findOne: jest.fn(),
      save: jest.fn(async (u: unknown) => u),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    subsRepo = {
      find: jest.fn().mockResolvedValue([]),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    examsRepo = { count: jest.fn().mockResolvedValue(0) };
    answersRepo = {};
    aiRepo = {
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ calls: '0', cost: '0' }),
        getRawMany: jest.fn().mockResolvedValue([]),
      })),
    };
    flagsRepo = {
      findOne: jest.fn(),
      save: jest.fn(async (f: unknown) => f),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    questionsRepo = {};
    auditRepo = {
      create: jest.fn((o: unknown) => o),
      save: jest.fn(async (a: unknown) => a),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    xpTxRepo = {};
    xpRedemptionRepo = {};
    referralsRepo = {};
    pmTestRepo = {};
    winnersRepo = {};

    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: getRepositoryToken(Subscription), useValue: subsRepo },
        { provide: getRepositoryToken(Exam), useValue: examsRepo },
        { provide: getRepositoryToken(ExamAnswer), useValue: answersRepo },
        { provide: getRepositoryToken(AiUsageLog), useValue: aiRepo },
        { provide: getRepositoryToken(QuestionFlag), useValue: flagsRepo },
        { provide: getRepositoryToken(Question), useValue: questionsRepo },
        { provide: getRepositoryToken(AuditLog), useValue: auditRepo },
        { provide: getRepositoryToken(XpTransaction), useValue: xpTxRepo },
        {
          provide: getRepositoryToken(XpRedemption),
          useValue: xpRedemptionRepo,
        },
        { provide: getRepositoryToken(ReferralEvent), useValue: referralsRepo },
        { provide: getRepositoryToken(PmTestQuestion), useValue: pmTestRepo },
        { provide: getRepositoryToken(Winner), useValue: winnersRepo },
      ],
    }).compile();
    service = moduleRef.get(AdminService);
  });

  // -------------------------------- banUser --------------------------------

  it('banUser throws NotFound for an unknown id', async () => {
    usersRepo.findOne.mockResolvedValueOnce(null);
    await expect(service.banUser('admin-1', 'ghost')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(auditRepo.save).not.toHaveBeenCalled();
  });

  it('banUser flips isActive=false and writes an audit row', async () => {
    usersRepo.findOne.mockResolvedValueOnce({ id: 'u', isActive: true });
    await service.banUser('admin-1', 'u', '1.2.3.4');
    expect(usersRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: false }),
    );
    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: 'admin-1',
        action: 'user.ban',
        entityType: 'user',
        entityId: 'u',
        newValue: { isActive: false },
        ipAddress: '1.2.3.4',
      }),
    );
  });

  // ------------------------------ resolveFlag ------------------------------

  it('resolveFlag throws NotFound for an unknown id', async () => {
    flagsRepo.findOne.mockResolvedValueOnce(null);
    await expect(
      service.resolveFlag('admin-1', 'flag-x'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('resolveFlag stamps resolvedBy + resolvedAt and writes an audit row', async () => {
    const flag = {
      id: 'f',
      isResolved: false,
      resolvedBy: null,
      resolvedAt: null,
    };
    flagsRepo.findOne.mockResolvedValueOnce(flag);
    await service.resolveFlag('admin-1', 'f', '1.2.3.4');
    expect(flag.isResolved).toBe(true);
    expect(flag.resolvedBy).toBe('admin-1');
    expect(flag.resolvedAt).toBeInstanceOf(Date);
    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'question_flag.resolve',
        entityId: 'f',
      }),
    );
  });

  // -------------------------------- getUser --------------------------------

  it('getUser throws NotFound when the user is missing', async () => {
    usersRepo.findOne.mockResolvedValueOnce(null);
    await expect(service.getUser('ghost')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('getUser returns the user + subs + examsCount + aiUsage in one call', async () => {
    usersRepo.findOne.mockResolvedValueOnce({ id: 'u' });
    subsRepo.find.mockResolvedValueOnce([{ id: 's1' }]);
    examsRepo.count.mockResolvedValueOnce(7);
    const out = await service.getUser('u');
    expect(out.user.id).toBe('u');
    expect(out.subscriptions).toHaveLength(1);
    expect(out.examsCount).toBe(7);
    expect(out.aiUsage).toBeDefined();
  });

  // ------------------------------ pagination ------------------------------

  it('listAudit caps the limit at 200 and orders newest first', async () => {
    await service.listAudit({ page: 1, limit: 9999 } as never);
    expect(auditRepo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200, order: { createdAt: 'DESC' } }),
    );
  });

  it('listUsers defaults to limit=20 newest-first', async () => {
    // Switched from findAndCount to createQueryBuilder so the optional
    // `search` param can compose case-insensitive LIKE clauses. The
    // unfiltered path still goes through the same query builder — assert
    // on the orderBy + take to lock in the defaults.
    const qb = {
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    (usersRepo as unknown as { createQueryBuilder: jest.Mock }).createQueryBuilder =
      jest.fn().mockReturnValue(qb);
    await service.listUsers({} as never);
    expect(qb.orderBy).toHaveBeenCalledWith('u.createdAt', 'DESC');
    expect(qb.take).toHaveBeenCalledWith(20);
    expect(qb.andWhere).not.toHaveBeenCalled();
  });

  it('listUsers wires the search param into a case-insensitive LIKE', async () => {
    const qb = {
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    (usersRepo as unknown as { createQueryBuilder: jest.Mock }).createQueryBuilder =
      jest.fn().mockReturnValue(qb);
    await service.listUsers({ search: 'Ekow' } as never);
    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('like :q'),
      { q: '%ekow%' },
    );
  });

  it('listSubscriptions joins plan + caps limit at 200', async () => {
    await service.listSubscriptions({ limit: 500 } as never);
    expect(subsRepo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200, relations: ['plan'] }),
    );
  });
});
