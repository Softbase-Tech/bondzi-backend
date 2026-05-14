import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SubscriptionsService } from './subscriptions.service';
import { Subscription } from './entities/subscription.entity';
import { User } from '../users/entities/user.entity';
import { PlansService } from './plans/plans.service';
import { PaymentProviderRegistry } from '../payments/providers/payment-provider.registry';
import { RedisService } from '../../common/redis/redis.service';
import { BillingInterval, SubscriptionStatus } from '../../common/types/enums';

/**
 * SubscriptionsService specs. Focus on the call paths that gate revenue
 * and the cache invalidation contract that SubscriptionGuard depends on.
 *
 *   - hasActiveSubscription / getActiveSubscription respect the Redis
 *     cache and fall through to a DB lookup when cold.
 *   - cancel updates status to CANCELLED, swallows provider-side errors
 *     (we still want the local cancel to land if the provider hiccups),
 *     and invalidates the cache.
 *   - verify rejects unknown references / cross-user references / provider
 *     non-success and flips status to ACTIVE on success.
 *   - initiate requires an email, fetches plan + cadence, persists a
 *     pending TRIAL row.
 */

const baseUser = {
  id: 'user-1',
  email: 'jane@example.com',
  countryCode: 'GH',
} as unknown as User;

const basePlan = {
  id: 'plan-1',
  name: 'Bondzi Pro',
  provider: 'paystack',
  currency: 'GHS',
  countryCode: 'GH',
};

describe('SubscriptionsService', () => {
  let service: SubscriptionsService;
  let subsRepo: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let usersRepo: { findOne: jest.Mock };
  let plans: {
    getActiveForCheckout: jest.Mock;
    cadenceFor: jest.Mock;
  };
  let providers: { get: jest.Mock };
  let provider: {
    initializeCheckout: jest.Mock;
    verifyTransaction: jest.Mock;
    cancelSubscription: jest.Mock;
  };
  let redis: { getJson: jest.Mock; setJson: jest.Mock; del: jest.Mock };

  beforeEach(async () => {
    subsRepo = {
      findOne: jest.fn(),
      save: jest.fn(async (s) => s),
      create: jest.fn((o) => ({ ...o })),
      createQueryBuilder: jest.fn(),
    };
    usersRepo = { findOne: jest.fn() };
    plans = {
      getActiveForCheckout: jest.fn(),
      cadenceFor: jest.fn(),
    };
    provider = {
      initializeCheckout: jest.fn(),
      verifyTransaction: jest.fn(),
      cancelSubscription: jest.fn(),
    };
    providers = { get: jest.fn(() => provider) };
    redis = { getJson: jest.fn(), setJson: jest.fn(), del: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        SubscriptionsService,
        { provide: getRepositoryToken(Subscription), useValue: subsRepo },
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: PlansService, useValue: plans },
        { provide: PaymentProviderRegistry, useValue: providers },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();
    service = moduleRef.get(SubscriptionsService);
  });

  // ----------------------- hasActiveSubscription -----------------------

  describe('hasActiveSubscription / getActiveSubscription', () => {
    function stubLatestActive(sub: Subscription | null) {
      subsRepo.createQueryBuilder.mockReturnValueOnce({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(sub),
      });
    }

    it('returns true when Redis reports an active cached sub and the DB confirms', async () => {
      redis.getJson.mockResolvedValueOnce({
        id: 'sub-1',
        status: SubscriptionStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      });
      subsRepo.findOne.mockResolvedValueOnce({
        id: 'sub-1',
        status: SubscriptionStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 86400_000),
      } as Subscription);
      expect(await service.hasActiveSubscription('user-1')).toBe(true);
    });

    it('falls back to a DB lookup when the cache is cold + caches the result', async () => {
      redis.getJson.mockResolvedValueOnce(null);
      stubLatestActive({
        id: 'sub-1',
        status: SubscriptionStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 60_000),
      } as Subscription);
      const out = await service.getActiveSubscription('user-1');
      expect(out?.id).toBe('sub-1');
      expect(redis.setJson).toHaveBeenCalled();
    });

    it('returns null + caches "expired" sentinel when no active sub exists', async () => {
      redis.getJson.mockResolvedValueOnce(null);
      stubLatestActive(null);
      expect(await service.getActiveSubscription('user-1')).toBeNull();
      expect(redis.setJson).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: SubscriptionStatus.EXPIRED }),
        expect.any(Number),
      );
    });
  });

  // ------------------------------ initiate ------------------------------

  describe('initiate', () => {
    it('rejects when the user has no email (Paystack requires one)', async () => {
      plans.getActiveForCheckout.mockResolvedValueOnce(basePlan);
      plans.cadenceFor.mockReturnValueOnce({
        providerPlanCode: 'p_monthly',
        amountMinor: 5000,
        amountDisplay: 50,
        durationDays: 30,
      });
      usersRepo.findOne.mockResolvedValueOnce({ id: 'user-1', email: null });
      await expect(
        service.initiate('user-1', 'plan-1', BillingInterval.MONTHLY),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when the cadence has no provider plan code (admin needs to sync)', async () => {
      plans.getActiveForCheckout.mockResolvedValueOnce(basePlan);
      plans.cadenceFor.mockReturnValueOnce({
        providerPlanCode: null,
        amountMinor: 5000,
        amountDisplay: 50,
        durationDays: 30,
      });
      await expect(
        service.initiate('user-1', 'plan-1', BillingInterval.MONTHLY),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('happy path: persists a pending TRIAL row and returns the auth URL', async () => {
      plans.getActiveForCheckout.mockResolvedValueOnce(basePlan);
      plans.cadenceFor.mockReturnValueOnce({
        providerPlanCode: 'p_monthly',
        amountMinor: 5000,
        amountDisplay: 50,
        durationDays: 30,
      });
      usersRepo.findOne.mockResolvedValueOnce(baseUser);
      provider.initializeCheckout.mockResolvedValueOnce({
        authorizationUrl: 'https://checkout.paystack.com/x',
        reference: 'ref_1',
      });
      const out = await service.initiate(
        'user-1',
        'plan-1',
        BillingInterval.MONTHLY,
      );
      expect(out.authorizationUrl).toContain('paystack');
      expect(subsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          status: SubscriptionStatus.TRIAL,
          providerReference: 'ref_1',
        }),
      );
    });
  });

  // ------------------------------ verify ------------------------------

  describe('verify', () => {
    it('rejects unknown references with NotFound', async () => {
      subsRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.verify('user-1', 'ref_x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects a reference owned by a different user', async () => {
      subsRepo.findOne.mockResolvedValueOnce({
        userId: 'someone-else',
        provider: 'paystack',
      });
      await expect(service.verify('user-1', 'ref_x')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rejects when the provider returns a non-success status', async () => {
      subsRepo.findOne.mockResolvedValueOnce({
        userId: 'user-1',
        provider: 'paystack',
      });
      provider.verifyTransaction.mockResolvedValueOnce({ status: 'failed' });
      await expect(service.verify('user-1', 'ref_x')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('flips status to ACTIVE on success and invalidates the cache', async () => {
      const sub = {
        id: 'sub-1',
        userId: 'user-1',
        provider: 'paystack',
        status: SubscriptionStatus.TRIAL,
      } as Subscription;
      subsRepo.findOne.mockResolvedValueOnce(sub);
      provider.verifyTransaction.mockResolvedValueOnce({
        status: 'success',
        customerId: 'cus_1',
      });
      const out = await service.verify('user-1', 'ref_x');
      expect(out.status).toBe(SubscriptionStatus.ACTIVE);
      expect(redis.del).toHaveBeenCalled();
    });
  });

  // ------------------------------ cancel ------------------------------

  describe('cancel', () => {
    it('rejects when there is no active subscription', async () => {
      subsRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.cancel('user-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('swallows provider cancelSubscription errors and still flips status', async () => {
      const sub = {
        id: 'sub-1',
        userId: 'user-1',
        provider: 'paystack',
        providerSubscriptionId: 'pst_1',
        status: SubscriptionStatus.ACTIVE,
      } as Subscription;
      subsRepo.findOne.mockResolvedValueOnce(sub);
      provider.cancelSubscription.mockRejectedValueOnce(new Error('boom'));
      const out = await service.cancel('user-1');
      expect(out.status).toBe(SubscriptionStatus.CANCELLED);
      expect(redis.del).toHaveBeenCalled();
    });
  });
});
