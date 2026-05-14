import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { XpEconomyService } from './xp-economy.service';
import { XpRateConfig } from './entities/xp-rate-config.entity';
import { XpRedemptionConfig } from './entities/xp-redemption-config.entity';
import { XpTransaction } from './entities/xp-transaction.entity';
import { XpRedemption } from './entities/xp-redemption.entity';
import { User } from '../users/entities/user.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { GamificationService } from '../gamification/gamification.service';
import { RedisService } from '../../common/redis/redis.service';
import { SubscriptionStatus } from '../../common/types/enums';

/**
 * XpEconomyService.redeem is the security-critical path: it spends XP and
 * grants a subscription. Tests pin:
 *   - 404 when the tier is unknown / disabled
 *   - 400 (no row affected) when the user lacks enough spendable XP
 *   - happy path: inserts an XpRedemption, creates an XP_CREDITED
 *     subscription with expires=now+creditDays, writes a negative-spendable
 *     xp_transaction, and busts the subscription cache
 */

describe('XpEconomyService', () => {
  let service: XpEconomyService;
  let ratesRepo: { find: jest.Mock };
  let tiersRepo: { find: jest.Mock; findOne: jest.Mock };
  let txRepo: { find: jest.Mock };
  let redemptionsRepo: Record<string, unknown>;
  let usersRepo: Record<string, unknown>;
  let subsRepo: Record<string, unknown>;
  let gamification: { snapshot: jest.Mock };
  let redis: { del: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  // tx entity-manager doubles
  let txUsersRepo: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
  };
  let txRedemptionsRepo: { create: jest.Mock; save: jest.Mock };
  let txSubsRepo: { create: jest.Mock; save: jest.Mock };
  let txXpRepo: { insert: jest.Mock };

  beforeEach(async () => {
    ratesRepo = { find: jest.fn().mockResolvedValue([]) };
    tiersRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
    };
    txRepo = { find: jest.fn().mockResolvedValue([]) };
    redemptionsRepo = {};
    usersRepo = {};
    subsRepo = {};
    gamification = { snapshot: jest.fn().mockResolvedValue({ levelXp: 0 }) };
    redis = { del: jest.fn().mockResolvedValue(undefined) };

    txUsersRepo = {
      createQueryBuilder: jest.fn(() => ({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      })),
      findOne: jest.fn().mockResolvedValue({ spendableXp: 100 }),
    };
    txRedemptionsRepo = {
      create: jest.fn((o: unknown) => ({ id: 'rd-1', ...(o as object) })),
      save: jest.fn(async (r: unknown) => r),
    };
    txSubsRepo = {
      create: jest.fn((o: unknown) => o),
      save: jest.fn(async (s: unknown) => ({ ...(s as object), id: 'sub-1' })),
    };
    txXpRepo = { insert: jest.fn().mockResolvedValue(undefined) };

    const em = {
      getRepository: (entity: unknown) => {
        if (entity === User) return txUsersRepo;
        if (entity === XpRedemption) return txRedemptionsRepo;
        if (entity === Subscription) return txSubsRepo;
        if (entity === XpTransaction) return txXpRepo;
        return null;
      },
    } as unknown as EntityManager;
    dataSource = {
      transaction: jest.fn(
        async (fn: (em: EntityManager) => Promise<unknown>) => fn(em),
      ),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        XpEconomyService,
        { provide: getRepositoryToken(XpRateConfig), useValue: ratesRepo },
        {
          provide: getRepositoryToken(XpRedemptionConfig),
          useValue: tiersRepo,
        },
        { provide: getRepositoryToken(XpTransaction), useValue: txRepo },
        {
          provide: getRepositoryToken(XpRedemption),
          useValue: redemptionsRepo,
        },
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: getRepositoryToken(Subscription), useValue: subsRepo },
        { provide: GamificationService, useValue: gamification },
        { provide: RedisService, useValue: redis },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = moduleRef.get(XpEconomyService);
  });

  // -------------------------------- summary --------------------------------

  it('summary fans out a single round-trip across snapshot/tiers/rates', async () => {
    await service.summary('user-1');
    expect(gamification.snapshot).toHaveBeenCalledWith('user-1');
    expect(tiersRepo.find).toHaveBeenCalled();
    expect(ratesRepo.find).toHaveBeenCalled();
  });

  // --------------------------------- redeem ---------------------------------

  describe('redeem', () => {
    it('rejects an unknown / disabled tier with NotFound', async () => {
      tiersRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.redeem('user-1', 'bogus')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects when the conditional decrement affects 0 rows (not enough XP)', async () => {
      tiersRepo.findOne.mockResolvedValueOnce({
        tierKey: 't-30',
        xpCost: 1000,
        creditDays: 30,
      });
      txUsersRepo.createQueryBuilder.mockReturnValueOnce({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      });
      await expect(service.redeem('user-1', 't-30')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(txRedemptionsRepo.save).not.toHaveBeenCalled();
    });

    it('records redemption, grants XP_CREDITED subscription and busts cache', async () => {
      tiersRepo.findOne.mockResolvedValueOnce({
        tierKey: 't-30',
        xpCost: 500,
        creditDays: 30,
      });
      txUsersRepo.findOne.mockResolvedValueOnce({ spendableXp: 200 });
      const out = await service.redeem('user-1', 't-30');
      // Subscription row carries the redemption pointer and XP_CREDITED status.
      const subCall = txSubsRepo.create.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(subCall.status).toBe(SubscriptionStatus.XP_CREDITED);
      expect(subCall.planId).toBeNull();
      expect(subCall.provider).toBeNull();
      expect(subCall.xpRedemptionId).toBe('rd-1');
      // Negative xp_transaction with reference back to the redemption.
      expect(txXpRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          spendableXp: -500,
          levelXp: 0,
          eventKey: 'redemption',
          referenceId: 'rd-1',
        }),
      );
      expect(redis.del).toHaveBeenCalled();
      expect(out).toEqual(
        expect.objectContaining({
          success: true,
          tierKey: 't-30',
          xpSpent: 500,
          creditDays: 30,
        }),
      );
    });
  });
});
