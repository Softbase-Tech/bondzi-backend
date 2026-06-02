import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
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
    // DataSource.transaction(fn) runs the callback against a fake entity
    // manager whose `query` mock pretends `pg_advisory_xact_lock` succeeded
    // — that's all `applyWebhookActivation` needs from the lock layer.
    const dataSource = {
      transaction: jest.fn(async (fn: (em: unknown) => Promise<unknown>) =>
        fn({ query: jest.fn().mockResolvedValue(undefined) }),
      ),
    };

    const mail = { send: jest.fn().mockResolvedValue(undefined) };
    const promoCodes = {
      quote: jest.fn().mockResolvedValue(null),
      recordRedemption: jest.fn().mockResolvedValue(undefined),
    };
    const { MailService } = await import('../mail/mail.service');
    const { PromoCodesService } = await import(
      '../promo-codes/promo-codes.service'
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        SubscriptionsService,
        { provide: getRepositoryToken(Subscription), useValue: subsRepo },
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: PlansService, useValue: plans },
        { provide: PaymentProviderRegistry, useValue: providers },
        { provide: RedisService, useValue: redis },
        { provide: DataSource, useValue: dataSource },
        { provide: MailService, useValue: mail },
        { provide: PromoCodesService, useValue: promoCodes },
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

    it('happy path: persists a pending PAST_DUE row and returns the auth URL', async () => {
      // Pre-payment rows MUST be PAST_DUE (NOT TRIAL). TRIAL is in the
      // active-grant set used by SubscriptionGuard + getActiveSubscription;
      // a TRIAL row with a future expires_at would unlock Pro for the full
      // plan window with no payment. PAST_DUE sits outside every isActive()
      // check, so the row stays dormant until verify() or the Paystack
      // webhook flips it to ACTIVE.
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
          status: SubscriptionStatus.PAST_DUE,
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
        status: SubscriptionStatus.PAST_DUE,
      });
      provider.verifyTransaction.mockResolvedValueOnce({ status: 'failed' });
      await expect(service.verify('user-1', 'ref_x')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rejects when Paystack returns success but amount paid is lower than expected', async () => {
      // amountGhs '50.00' = 5000 pesewas; tampered paid amount = 100p (1 GHS)
      // is well outside the AMOUNT_MATCH_TOLERANCE_MINOR window.
      subsRepo.findOne.mockResolvedValueOnce({
        id: 'sub-1',
        userId: 'user-1',
        provider: 'paystack',
        status: SubscriptionStatus.PAST_DUE,
        amountGhs: '50.00',
      });
      provider.verifyTransaction.mockResolvedValueOnce({
        status: 'success',
        amountMinor: 100,
        customerId: 'cus_1',
      });
      await expect(service.verify('user-1', 'ref_x')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(subsRepo.save).not.toHaveBeenCalled();
    });

    it('short-circuits when the subscription is already ACTIVE (no Paystack roundtrip)', async () => {
      subsRepo.findOne.mockResolvedValueOnce({
        id: 'sub-1',
        userId: 'user-1',
        provider: 'paystack',
        status: SubscriptionStatus.ACTIVE,
      });
      const out = await service.verify('user-1', 'ref_x');
      expect(out.status).toBe(SubscriptionStatus.ACTIVE);
      expect(provider.verifyTransaction).not.toHaveBeenCalled();
    });

    it('flips status to ACTIVE on success and invalidates the cache', async () => {
      const sub = {
        id: 'sub-1',
        userId: 'user-1',
        provider: 'paystack',
        status: SubscriptionStatus.PAST_DUE,
        amountGhs: '50.00',
      } as Subscription;
      subsRepo.findOne.mockResolvedValueOnce(sub);
      provider.verifyTransaction.mockResolvedValueOnce({
        status: 'success',
        amountMinor: 5000,
        customerId: 'cus_1',
      });
      const out = await service.verify('user-1', 'ref_x');
      expect(out.status).toBe(SubscriptionStatus.ACTIVE);
      expect(redis.del).toHaveBeenCalled();
    });
  });

  // -------------------------- applyWebhookStatus --------------------------

  describe('applyWebhookStatus', () => {
    it('scopes the status update to a SINGLE subscription row (by id), not every row for the user', async () => {
      // The previous shape was `update({ userId }, { status })` — a
      // `subscription.disable` event would flip every historical row
      // (active, xp_credited, expired) to CANCELLED. Verify we now
      // look up by id and only save that one.
      const targetSub = {
        id: 'sub-1',
        userId: 'user-1',
        status: SubscriptionStatus.ACTIVE,
      } as Subscription;
      subsRepo.findOne.mockResolvedValueOnce(targetSub);
      await service.applyWebhookStatus('sub-1', SubscriptionStatus.CANCELLED);
      expect(subsRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'sub-1' },
      });
      expect(subsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'sub-1',
          status: SubscriptionStatus.CANCELLED,
        }),
      );
      expect(redis.del).toHaveBeenCalled();
    });

    it('is a no-op when the subscription id is unknown (defensive)', async () => {
      subsRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.applyWebhookStatus('missing', SubscriptionStatus.CANCELLED),
      ).resolves.toBeUndefined();
      expect(subsRepo.save).not.toHaveBeenCalled();
    });
  });

  // ------------------------------ cancel ------------------------------

  describe('cancel', () => {
    /**
     * `cancel` now uses createQueryBuilder so it can match any of the
     * "live" statuses (ACTIVE / TRIAL / XP_CREDITED) — the previous
     * shape only matched ACTIVE and 404'd for trial/xp_credited users.
     */
    function stubLiveSubQb(sub: Subscription | null) {
      subsRepo.createQueryBuilder.mockReturnValueOnce({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(sub),
      });
    }

    it('rejects when there is no live subscription (active/trial/xp_credited)', async () => {
      stubLiveSubQb(null);
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
      stubLiveSubQb(sub);
      provider.cancelSubscription.mockRejectedValueOnce(new Error('boom'));
      const out = await service.cancel('user-1');
      expect(out.status).toBe(SubscriptionStatus.CANCELLED);
      expect(redis.del).toHaveBeenCalled();
    });

    it('also cancels TRIAL and XP_CREDITED subs (audit fix #41)', async () => {
      const sub = {
        id: 'sub-2',
        userId: 'user-1',
        status: SubscriptionStatus.XP_CREDITED,
        provider: null,
        providerSubscriptionId: null,
      } as Subscription;
      stubLiveSubQb(sub);
      const out = await service.cancel('user-1');
      expect(out.status).toBe(SubscriptionStatus.CANCELLED);
    });
  });
});
