import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { WinnerSelectionService } from './winner-selection.service';
import { LeaderboardEntry } from './entities/leaderboard-entry.entity';
import { Winner } from './entities/winner.entity';
import { User } from '../users/entities/user.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { GamificationService } from '../gamification/gamification.service';
import {
  ExamType,
  LeaderboardPeriodType,
  NotificationChannel,
} from '../../common/types/enums';

/**
 * WinnerSelectionService is admin-triggered, never scheduled, and writes both
 * to the winners ledger AND to the XP ledger. The non-obvious behaviour:
 *   - eventKeyFor maps rank → reward-tier key (weekly_winner_1 / _2 / _3 /
 *     _4_10 / _11_20, plus the monthly variants).
 *   - selectWinners refuses to re-run for an already-paid period (BadRequest).
 *   - ineligible candidates do NOT promote anyone else — they're skipped and
 *     the slot stays empty.
 *   - on awardXp success the winners row is flipped to xpIssued=true with the
 *     real xpAmount, and an IN_APP notification is queued.
 */

const makeUser = (over: Partial<User> = {}): User =>
  ({
    id: 'user-1',
    isActive: true,
    deletedAt: null,
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30d ago
    email: 'a@b.com',
    phone: null,
    ...over,
  }) as User;

describe('WinnerSelectionService', () => {
  let service: WinnerSelectionService;
  let entriesRepo: { createQueryBuilder: jest.Mock };
  let winnersRepo: {
    count: jest.Mock;
    createQueryBuilder: jest.Mock;
    update: jest.Mock;
  };
  let usersRepo: Record<string, unknown>;
  let answersRepo: { count: jest.Mock };
  let notificationsRepo: { insert: jest.Mock };
  let gamification: { awardXp: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    entriesRepo = { createQueryBuilder: jest.fn() };
    winnersRepo = {
      count: jest.fn(),
      createQueryBuilder: jest.fn(),
      update: jest.fn(),
    };
    usersRepo = {};
    answersRepo = { count: jest.fn() };
    notificationsRepo = { insert: jest.fn() };
    gamification = { awardXp: jest.fn() };

    dataSource = {
      transaction: jest.fn(
        async (fn: (em: EntityManager) => Promise<unknown>) =>
          fn({
            getRepository: () => ({
              create: (o: unknown) => ({ id: 'w-1', ...(o as object) }),
              save: jest.fn(async (w: unknown) => w),
            }),
          } as unknown as EntityManager),
      ),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        WinnerSelectionService,
        {
          provide: getRepositoryToken(LeaderboardEntry),
          useValue: entriesRepo,
        },
        { provide: getRepositoryToken(Winner), useValue: winnersRepo },
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: getRepositoryToken(ExamAnswer), useValue: answersRepo },
        {
          provide: getRepositoryToken(Notification),
          useValue: notificationsRepo,
        },
        { provide: GamificationService, useValue: gamification },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = moduleRef.get(WinnerSelectionService);
  });

  // ----------------------------- eventKeyFor -----------------------------

  it('eventKeyFor maps weekly ranks to the right tier key', () => {
    expect(service.eventKeyFor(LeaderboardPeriodType.WEEKLY, 1)).toBe(
      'weekly_winner_1',
    );
    expect(service.eventKeyFor(LeaderboardPeriodType.WEEKLY, 2)).toBe(
      'weekly_winner_2',
    );
    expect(service.eventKeyFor(LeaderboardPeriodType.WEEKLY, 3)).toBe(
      'weekly_winner_3',
    );
    expect(service.eventKeyFor(LeaderboardPeriodType.WEEKLY, 5)).toBe(
      'weekly_winner_4_10',
    );
    expect(service.eventKeyFor(LeaderboardPeriodType.WEEKLY, 15)).toBe(
      'weekly_winner_11_20',
    );
  });

  it('eventKeyFor maps monthly ranks to the right tier key', () => {
    expect(service.eventKeyFor(LeaderboardPeriodType.MONTHLY, 1)).toBe(
      'monthly_winner_1',
    );
    expect(service.eventKeyFor(LeaderboardPeriodType.MONTHLY, 2)).toBe(
      'monthly_winner_2_3',
    );
    expect(service.eventKeyFor(LeaderboardPeriodType.MONTHLY, 7)).toBe(
      'monthly_winner_4_10',
    );
    expect(service.eventKeyFor(LeaderboardPeriodType.MONTHLY, 12)).toBe(
      'monthly_winner_11_20',
    );
  });

  // ----------------------------- selectWinners -----------------------------

  it('refuses to re-run when winners already exist for the period', async () => {
    winnersRepo.count.mockResolvedValueOnce(1);
    await expect(
      service.selectWinners({
        examType: ExamType.WASSCE,
        periodType: LeaderboardPeriodType.WEEKLY,
        periodStart: '2026-05-11',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('skips ineligible candidates without consuming a rank slot', async () => {
    winnersRepo.count.mockResolvedValueOnce(0);
    // Pool: [too-new, eligible]. The first one is < 3 days old → skipped.
    const tooNew = makeUser({
      id: 'u-new',
      createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    });
    const eligible = makeUser({ id: 'u-good' });
    const qb = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        { userId: 'u-new', user: tooNew, weeklyXp: 9999 },
        { userId: 'u-good', user: eligible, weeklyXp: 8000 },
      ]),
    };
    entriesRepo.createQueryBuilder.mockReturnValueOnce(qb);
    answersRepo.count.mockResolvedValue(60); // >50 threshold met
    gamification.awardXp.mockResolvedValue({ xpAmount: 5000 });

    const out = await service.selectWinners({
      examType: ExamType.WASSCE,
      periodType: LeaderboardPeriodType.WEEKLY,
      periodStart: '2026-05-11',
    });

    expect(out.awarded).toBe(1);
    expect(out.skippedForAntiCheat).toBe(1);
    expect(out.winners[0]).toEqual(
      expect.objectContaining({
        userId: 'u-good',
        rank: 1,
        eventKey: 'weekly_winner_1',
        xpEarned: 5000,
      }),
    );
    // The slot taken by the eligible user is rank 1, not rank 2.
    expect(winnersRepo.update).toHaveBeenCalledWith(
      'w-1',
      expect.objectContaining({ xpIssued: true, xpEarned: 5000 }),
    );
    // In-app notification fires for the awarded winner.
    expect(notificationsRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u-good',
        channel: NotificationChannel.IN_APP,
      }),
    );
  });

  it('treats fewer-than-50-answers as ineligible', async () => {
    winnersRepo.count.mockResolvedValueOnce(0);
    const user = makeUser({ id: 'u-fresh' });
    const qb = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest
        .fn()
        .mockResolvedValue([{ userId: 'u-fresh', user, weeklyXp: 9999 }]),
    };
    entriesRepo.createQueryBuilder.mockReturnValueOnce(qb);
    answersRepo.count.mockResolvedValueOnce(40); // below MIN_ANSWERS

    const out = await service.selectWinners({
      examType: ExamType.WASSCE,
      periodType: LeaderboardPeriodType.WEEKLY,
      periodStart: '2026-05-11',
    });
    expect(out.awarded).toBe(0);
    expect(out.skippedForAntiCheat).toBe(1);
    expect(gamification.awardXp).not.toHaveBeenCalled();
  });
});
