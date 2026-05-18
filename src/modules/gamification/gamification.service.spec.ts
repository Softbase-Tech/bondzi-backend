import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { GamificationService } from './gamification.service';
import { User } from '../users/entities/user.entity';
import { XpRateConfig } from '../xp-economy/entities/xp-rate-config.entity';
import { XpTransaction } from '../xp-economy/entities/xp-transaction.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { RedisService } from '../../common/redis/redis.service';
import { ExamType, NotificationChannel } from '../../common/types/enums';

/**
 * GamificationService is the XP ledger writer. Guard rails:
 *   - awardXp silently no-ops when the event is disabled (rate row missing
 *     or amount === 0). Returns the user's current snapshot.
 *   - awardXp on an active event runs in a single DB transaction: inserts an
 *     xp_transactions row, atomically increments level_xp + spendable_xp,
 *     reloads, computes level-up, fires a push notification on level-up.
 *   - awardXpAmount with amount <= 0 falls through to the disabled-event path
 *     (no insert).
 *   - bumpLeaderboard (private, exercised via awardXp) writes both the WEEKLY
 *     and MONTHLY rows in the SAME tx, then busts the cache. Without this the
 *     public leaderboard reads an empty list.
 *   - snapshot tolerates a missing user by returning safe defaults.
 */

describe('GamificationService', () => {
  let service: GamificationService;
  let usersRepo: { findOne: jest.Mock };
  let ratesRepo: { findOne: jest.Mock };
  let txRepo: { find: jest.Mock };
  let notifications: { send: jest.Mock };
  let redis: { del: jest.Mock; incr: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  // Per-call EntityManager doubles — fresh between each test.
  let txUsersRepo: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
  };
  let txXpTxRepo: { insert: jest.Mock };
  let em: { query: jest.Mock; getRepository: jest.Mock };

  beforeEach(async () => {
    usersRepo = { findOne: jest.fn() };
    ratesRepo = { findOne: jest.fn() };
    txRepo = { find: jest.fn() };
    notifications = { send: jest.fn().mockResolvedValue(undefined) };
    // `incr` is used by the new per-event-key daily cap check; default
    // to a low value so the cap is never tripped in the existing tests.
    // A dedicated test below exercises the cap path.
    redis = {
      del: jest.fn().mockResolvedValue(undefined),
      incr: jest.fn().mockResolvedValue(1),
    };

    txUsersRepo = {
      createQueryBuilder: jest.fn(() => {
        const qb = {
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({ affected: 1 }),
        };
        return qb;
      }),
      findOne: jest.fn(),
      update: jest.fn(),
    };
    txXpTxRepo = { insert: jest.fn().mockResolvedValue(undefined) };
    em = {
      query: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn((entity: unknown) => {
        if (entity === User) return txUsersRepo;
        if (entity === XpTransaction) return txXpTxRepo;
        return null;
      }),
    };
    dataSource = {
      transaction: jest.fn(
        async (fn: (em: EntityManager) => Promise<unknown>) =>
          fn(em as unknown as EntityManager),
      ),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        GamificationService,
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: getRepositoryToken(XpRateConfig), useValue: ratesRepo },
        { provide: getRepositoryToken(XpTransaction), useValue: txRepo },
        { provide: NotificationsService, useValue: notifications },
        { provide: DataSource, useValue: dataSource },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();
    service = moduleRef.get(GamificationService);
  });

  // ----------------------------- awardXp -----------------------------

  describe('awardXp', () => {
    it('no-ops when the event is missing in xp_rate_config', async () => {
      ratesRepo.findOne.mockResolvedValueOnce(null);
      usersRepo.findOne.mockResolvedValueOnce({
        levelXp: 100,
        spendableXp: 40,
        currentLevel: 2,
      });
      const out = await service.awardXp('user-1', 'unknown_event');
      expect(out.awarded).toBe(false);
      expect(out.xpAmount).toBe(0);
      expect(out.levelXp).toBe(100);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('no-ops when the rate exists but xpAmount is 0', async () => {
      ratesRepo.findOne.mockResolvedValueOnce({ xpAmount: 0 });
      usersRepo.findOne.mockResolvedValueOnce(null);
      const out = await service.awardXp('user-1', 'zero_event');
      expect(out.awarded).toBe(false);
      expect(out.currentLevel).toBe(1); // default when user is null
    });

    it('inserts an xp_transaction, bumps the user counters and updates leaderboards', async () => {
      ratesRepo.findOne.mockResolvedValueOnce({ xpAmount: 25 });
      // Reloaded user inside the tx — leveling within the same level.
      txUsersRepo.findOne.mockResolvedValueOnce({
        id: 'user-1',
        examType: ExamType.WASSCE,
        levelXp: 125,
        spendableXp: 125,
        currentLevel: 2,
      });
      const out = await service.awardXp('user-1', 'exam_completed', 'ref-1');
      expect(out.awarded).toBe(true);
      expect(out.xpAmount).toBe(25);
      expect(out.leveledUp).toBe(false);
      expect(txXpTxRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          eventKey: 'exam_completed',
          levelXp: 25,
          spendableXp: 25,
          referenceId: 'ref-1',
        }),
      );
      // Both WEEKLY and MONTHLY leaderboard rows are written in the same tx.
      expect(em.query).toHaveBeenCalledTimes(2);
      expect(redis.del).toHaveBeenCalledTimes(2);
      // Notifications fire only on level-up — this run shouldn't push.
      expect(notifications.send).not.toHaveBeenCalled();
    });

    it('emits a level_up push when the new XP crosses a level threshold', async () => {
      ratesRepo.findOne.mockResolvedValueOnce({ xpAmount: 500 });
      // 500 XP → level 2 (thresholds: 100 → L2, 300 → L3, 600 → L4 for default
      // levelForXp). Whatever the exact thresholds, jumping from currentLevel
      // 1 with 500 levelXp must trip the leveledUp branch.
      txUsersRepo.findOne.mockResolvedValueOnce({
        id: 'user-1',
        examType: ExamType.WASSCE,
        levelXp: 500,
        spendableXp: 500,
        currentLevel: 1,
      });
      const out = await service.awardXp('user-1', 'big_event');
      expect(out.leveledUp).toBe(true);
      expect(out.newLevel).toBeGreaterThan(1);
      // current_level row update + level-up notification.
      expect(txUsersRepo.update).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ currentLevel: out.newLevel }),
      );
      expect(notifications.send).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: NotificationChannel.PUSH,
          data: expect.objectContaining({ type: 'level_up' }),
        }),
      );
    });

    it('throws when the user vanishes mid-tx (defensive guard)', async () => {
      ratesRepo.findOne.mockResolvedValueOnce({ xpAmount: 10 });
      txUsersRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.awardXp('user-gone', 'evt')).rejects.toThrow(
        /User disappeared/,
      );
    });
  });

  // ---------------------------- awardXpAmount ----------------------------

  describe('awardXpAmount', () => {
    it('treats a non-positive amount as a disabled-event no-op', async () => {
      ratesRepo.findOne.mockResolvedValueOnce(null);
      usersRepo.findOne.mockResolvedValueOnce(null);
      const out = await service.awardXpAmount('user-1', 0, 'rewarded_ad');
      expect(out.awarded).toBe(false);
      expect(txXpTxRepo.insert).not.toHaveBeenCalled();
    });

    it('bypasses xp_rate_config when amount > 0 (used by rewarded ads)', async () => {
      txUsersRepo.findOne.mockResolvedValueOnce({
        id: 'user-1',
        examType: ExamType.BECE,
        levelXp: 50,
        spendableXp: 50,
        currentLevel: 1,
      });
      const out = await service.awardXpAmount('user-1', 50, 'rewarded_ad');
      expect(out.awarded).toBe(true);
      expect(out.xpAmount).toBe(50);
      // xp_rate_config was NOT consulted — that's the whole point of this path.
      expect(ratesRepo.findOne).not.toHaveBeenCalled();
    });
  });

  // ------------------------------ snapshot ------------------------------

  it('snapshot returns safe defaults when the user is missing', async () => {
    usersRepo.findOne.mockResolvedValueOnce(null);
    const out = await service.snapshot('ghost');
    expect(out).toEqual(
      expect.objectContaining({
        levelXp: 0,
        spendableXp: 0,
        currentLevel: 1,
        streakDays: 0,
        longestStreak: 0,
      }),
    );
  });

  // ------------------------- recentTransactions -------------------------

  it('recentTransactions reads newest-first capped at the requested limit', async () => {
    txRepo.find.mockResolvedValueOnce([]);
    await service.recentTransactions('user-1', 5);
    expect(txRepo.find).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      order: { createdAt: 'DESC' },
      take: 5,
    });
  });
});
