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
import { SubscriptionPlanEntity } from '../subscriptions/plans/entities/subscription-plan.entity';
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
  let txSubsRepo: {
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let txXpRepo: { insert: jest.Mock };
  let txPlansRepo: { findOne: jest.Mock };

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
    // Default: no existing active subscription so the redeem path falls
    // through to the "create new XP_CREDITED row" branch. Tests for the
    // "extend instead of stack" path override this stub.
    const noExistingActiveQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    };
    txSubsRepo = {
      create: jest.fn((o: unknown) => o),
      save: jest.fn(async (s: unknown) => ({ ...(s as object), id: 'sub-1' })),
      createQueryBuilder: jest.fn(() => noExistingActiveQb),
    };
    txXpRepo = { insert: jest.fn().mockResolvedValue(undefined) };
    // Default: no default Pro plan for the user's level. Tests for the
    // level-anchored happy path override this with a real plan stub.
    txPlansRepo = { findOne: jest.fn().mockResolvedValue(null) };

    const em = {
      getRepository: (entity: unknown) => {
        if (entity === User) return txUsersRepo;
        if (entity === XpRedemption) return txRedemptionsRepo;
        if (entity === Subscription) return txSubsRepo;
        if (entity === XpTransaction) return txXpRepo;
        if (entity === SubscriptionPlanEntity) return txPlansRepo;
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

    it('with no active sub: creates a fresh XP_CREDITED row and busts cache', async () => {
      tiersRepo.findOne.mockResolvedValueOnce({
        tierKey: 't-30',
        xpCost: 500,
        creditDays: 30,
      });
      // findOne stubs: first the spendableXp check, then the level-anchor
      // lookup (returns user without an examType so the anchor is null).
      txUsersRepo.findOne
        .mockResolvedValueOnce({ spendableXp: 200 })
        .mockResolvedValueOnce({ id: 'user-1', examType: null });
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

    it("anchors a fresh XP_CREDITED row to the user's level's default Pro plan", async () => {
      // Under the per-level entitlement model, the resolver joins through
      // plan_id to filter by level. A null planId would make the credit
      // invisible — `entitlementFor` would return Free on every level.
      // The redeem path resolves the user's examType and stamps the
      // matching default Pro plan as a level anchor.
      tiersRepo.findOne.mockResolvedValueOnce({
        tierKey: 't-30',
        xpCost: 500,
        creditDays: 30,
      });
      // First findOne: the level-anchor lookup (select examType,
      // countryCode). Second findOne: the post-save welcome-email
      // recipient lookup (full user row).
      txUsersRepo.findOne
        .mockResolvedValueOnce({
          id: 'user-1',
          examType: 'wassce',
          countryCode: 'GH',
        })
        .mockResolvedValueOnce({ spendableXp: 200 });
      txPlansRepo.findOne.mockResolvedValueOnce({
        id: 'plan-wassce-pro',
        countryCode: 'GH',
      });
      await service.redeem('user-1', 't-30');
      const subCall = txSubsRepo.create.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(subCall.planId).toBe('plan-wassce-pro');
      expect(subCall.countryCode).toBe('GH');
      expect(subCall.status).toBe(SubscriptionStatus.XP_CREDITED);
    });

    it('with an existing ACTIVE paid sub: extends its expires_at instead of inserting a new row', async () => {
      // CRITICAL: this is the launch-blocker test. The old shape stacked
      // an XP_CREDITED row on top of the paid sub, which let a user pay
      // via Paystack, redeem XP, then chargeback and keep premium via
      // the XP_CREDITED row.
      tiersRepo.findOne.mockResolvedValueOnce({
        tierKey: 't-30',
        xpCost: 500,
        creditDays: 30,
      });
      const futureExpiry = new Date(Date.now() + 5 * 86400 * 1000); // 5 days
      const existingPaidSub = {
        id: 'paid-sub-1',
        userId: 'user-1',
        status: SubscriptionStatus.ACTIVE,
        expiresAt: futureExpiry,
        xpRedemptionId: null,
      } as never;
      txSubsRepo.createQueryBuilder.mockReturnValueOnce({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(existingPaidSub),
      });
      await service.redeem('user-1', 't-30');
      // No new subscription row was created — the existing paid sub was
      // saved with an extended expires_at instead.
      expect(txSubsRepo.create).not.toHaveBeenCalled();
      expect(txSubsRepo.save).toHaveBeenCalledTimes(1);
      const saved = txSubsRepo.save.mock.calls[0][0] as {
        id: string;
        status: SubscriptionStatus;
        expiresAt: Date;
        xpRedemptionId: string | null;
      };
      expect(saved.id).toBe('paid-sub-1');
      expect(saved.status).toBe(SubscriptionStatus.ACTIVE); // unchanged
      expect(saved.expiresAt.getTime()).toBe(
        futureExpiry.getTime() + 30 * 86400 * 1000,
      );
      // Paid sub keeps xp_redemption_id NULL so the audit trail still
      // points the row at the original purchase, not the redemption.
      expect(saved.xpRedemptionId).toBeNull();
    });

    it('with an existing XP_CREDITED sub: extends AND tags the redemption pointer', async () => {
      tiersRepo.findOne.mockResolvedValueOnce({
        tierKey: 't-7',
        xpCost: 100,
        creditDays: 7,
      });
      const futureExpiry = new Date(Date.now() + 2 * 86400 * 1000);
      const existingXp = {
        id: 'xp-sub-1',
        userId: 'user-1',
        status: SubscriptionStatus.XP_CREDITED,
        expiresAt: futureExpiry,
        xpRedemptionId: 'old-rd',
      } as never;
      txSubsRepo.createQueryBuilder.mockReturnValueOnce({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(existingXp),
      });
      await service.redeem('user-1', 't-7');
      const saved = txSubsRepo.save.mock.calls[0][0] as {
        status: SubscriptionStatus;
        expiresAt: Date;
        xpRedemptionId: string | null;
      };
      expect(saved.status).toBe(SubscriptionStatus.XP_CREDITED);
      expect(saved.expiresAt.getTime()).toBe(
        futureExpiry.getTime() + 7 * 86400 * 1000,
      );
      // The XP-credit row picks up the new redemption pointer so the
      // audit chain stays correct.
      expect(saved.xpRedemptionId).toBe('rd-1');
    });
  });
});
