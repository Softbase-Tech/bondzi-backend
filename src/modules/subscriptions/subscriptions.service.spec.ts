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
import { Subject } from '../subjects/entities/subject.entity';
import { PlansService } from './plans/plans.service';
import { PaymentProviderRegistry } from '../payments/providers/payment-provider.registry';
import { PartnerCommissionsService } from '../partners/partner-commissions.service';
import { PaymentAttemptsService } from '../payments/payment-attempts.service';
import { RedisService } from '../../common/redis/redis.service';
import {
  AccountType,
  BillingInterval,
  PaymentAttemptStatus,
  PaymentKind,
  SubscriptionStatus,
} from '../../common/types/enums';

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
  account: AccountType.PRO,
  level: 'wassce',
  paymentKind: PaymentKind.RECURRING,
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
  let paymentAttempts: {
    createPending: jest.Mock;
    findByReference: jest.Mock;
    findById: jest.Mock;
    markPaid: jest.Mock;
    markFailed: jest.Mock;
    markFailedByReference: jest.Mock;
    markRefunded: jest.Mock;
    linkSubscription: jest.Mock;
  };

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
    // `getRepository(PaymentAttempt).createQueryBuilder()` powers
    // initiate's "double-tap pending guard"; default to "no recent
    // pending" so tests that don't care about the guard pass cleanly.
    const dataSource = {
      transaction: jest.fn(async (fn: (em: unknown) => Promise<unknown>) =>
        fn({ query: jest.fn().mockResolvedValue(undefined) }),
      ),
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(null),
        }),
      }),
    };

    const mail = { send: jest.fn().mockResolvedValue(undefined) };
    const promoCodes = {
      quote: jest.fn().mockResolvedValue(null),
      recordRedemption: jest.fn().mockResolvedValue(undefined),
    };
    paymentAttempts = {
      createPending: jest.fn(async (input) => ({
        id: 'pa-1',
        ...input,
        status: PaymentAttemptStatus.PENDING,
      })),
      findByReference: jest.fn(),
      findById: jest.fn(),
      markPaid: jest.fn(async (id) => ({
        id,
        status: PaymentAttemptStatus.PAID,
      })),
      markFailed: jest.fn(async (id) => ({
        id,
        status: PaymentAttemptStatus.FAILED,
      })),
      markFailedByReference: jest.fn().mockResolvedValue(null),
      markRefunded: jest.fn(),
      linkSubscription: jest.fn().mockResolvedValue(undefined),
    };
    const { MailService } = await import('../mail/mail.service');
    const { PromoCodesService } =
      await import('../promo-codes/promo-codes.service');
    const moduleRef = await Test.createTestingModule({
      providers: [
        SubscriptionsService,
        { provide: getRepositoryToken(Subscription), useValue: subsRepo },
        { provide: getRepositoryToken(User), useValue: usersRepo },
        // Subjects repo is injected by the assertCanStudySubject /
        // assertCanStudySubjects entitlement-gate helpers. None of the
        // tests in this file exercise those code paths, so a noop
        // mock is sufficient — it just needs to be DI-resolvable.
        {
          provide: getRepositoryToken(Subject),
          useValue: { findOne: jest.fn(), find: jest.fn() },
        },
        { provide: PlansService, useValue: plans },
        { provide: PaymentProviderRegistry, useValue: providers },
        { provide: RedisService, useValue: redis },
        { provide: DataSource, useValue: dataSource },
        { provide: MailService, useValue: mail },
        { provide: PromoCodesService, useValue: promoCodes },
        { provide: PaymentAttemptsService, useValue: paymentAttempts },
        {
          provide: PartnerCommissionsService,
          useValue: {
            creditPlusSubscription: jest.fn().mockResolvedValue(null),
            clawback: jest.fn().mockResolvedValue(null),
          },
        },
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
    // The dupe-check query runs FIRST inside `initiate` after the cadence
    // resolution. Every test in this block needs a stubbed empty result
    // — otherwise `null.getOne` throws before the test's real assertion
    // can run.
    function stubNoDuplicate() {
      subsRepo.createQueryBuilder.mockReturnValueOnce({
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      });
    }

    it('rejects when the user has no email (Paystack requires one)', async () => {
      plans.getActiveForCheckout.mockResolvedValueOnce(basePlan);
      stubNoDuplicate();
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
      stubNoDuplicate();
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

    it('rejects when an active subscription with the same cadence already exists', async () => {
      plans.getActiveForCheckout.mockResolvedValueOnce(basePlan);
      subsRepo.createQueryBuilder.mockReturnValueOnce({
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest
          .fn()
          .mockResolvedValue({ id: 'existing-sub' } as Subscription),
      });
      await expect(
        service.initiate('user-1', 'plan-1', BillingInterval.MONTHLY),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('happy path: persists a PENDING payment_attempt and returns the auth URL', async () => {
      // Pre-payment rows live in `payment_attempts`, NOT `subscriptions`.
      // No subscription is created until the Paystack callback confirms
      // the charge — at which point `consumePaidAttempt` upserts the
      // Plus/Pro row per the refactor brief.
      plans.getActiveForCheckout.mockResolvedValueOnce(basePlan);
      stubNoDuplicate();
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
      expect(paymentAttempts.createPending).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          planId: 'plan-1',
          billingInterval: BillingInterval.MONTHLY,
          amountMinor: 5000,
          amountGhs: 50,
          provider: 'paystack',
        }),
      );
      // No subscription row created at initiate time anymore.
      expect(subsRepo.save).not.toHaveBeenCalled();
    });
  });

  // ------------------------------ verify ------------------------------

  describe('verify', () => {
    // Reusable query-builder stub for `consumePaidAttempt`'s "existing
    // sub for this (user, level, account)" lookup — defaults to null
    // (fresh activation).
    function stubNoExistingSub() {
      subsRepo.createQueryBuilder.mockReturnValueOnce({
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      });
    }

    it('rejects unknown references with NotFound', async () => {
      paymentAttempts.findByReference.mockResolvedValueOnce(null);
      await expect(service.verify('user-1', 'ref_x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects a reference owned by a different user', async () => {
      paymentAttempts.findByReference.mockResolvedValueOnce({
        id: 'pa-1',
        userId: 'someone-else',
        provider: 'paystack',
        status: PaymentAttemptStatus.PENDING,
      });
      await expect(service.verify('user-1', 'ref_x')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rejects when the provider returns a non-success status and marks the attempt FAILED', async () => {
      paymentAttempts.findByReference.mockResolvedValueOnce({
        id: 'pa-1',
        userId: 'user-1',
        provider: 'paystack',
        status: PaymentAttemptStatus.PENDING,
        planId: 'plan-1',
        amountMinor: 5000,
      });
      provider.verifyTransaction.mockResolvedValueOnce({ status: 'failed' });
      await expect(service.verify('user-1', 'ref_x')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(paymentAttempts.markFailed).toHaveBeenCalledWith(
        'pa-1',
        expect.stringContaining('failed'),
      );
    });

    it('rejects when Paystack returns success but amount paid is lower than expected', async () => {
      // amountMinor=5000 (50 GHS); tampered paid = 100p (1 GHS) is
      // well outside the AMOUNT_MATCH_TOLERANCE_MINOR window.
      paymentAttempts.findByReference.mockResolvedValueOnce({
        id: 'pa-1',
        userId: 'user-1',
        provider: 'paystack',
        status: PaymentAttemptStatus.PENDING,
        planId: 'plan-1',
        amountMinor: 5000,
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
      expect(paymentAttempts.markPaid).not.toHaveBeenCalled();
    });

    it('short-circuits when the attempt is already PAID and a linked subscription exists', async () => {
      paymentAttempts.findByReference.mockResolvedValueOnce({
        id: 'pa-1',
        userId: 'user-1',
        provider: 'paystack',
        status: PaymentAttemptStatus.PAID,
        subscriptionId: 'sub-1',
      });
      subsRepo.findOne.mockResolvedValueOnce({
        id: 'sub-1',
        userId: 'user-1',
        status: SubscriptionStatus.ACTIVE,
        plan: { account: AccountType.PRO, paymentKind: PaymentKind.RECURRING },
      } as unknown as Subscription);
      const out = await service.verify('user-1', 'ref_x');
      expect(provider.verifyTransaction).not.toHaveBeenCalled();
      // The reload above resolves via toMeView, which surfaces
      // status from the joined entity.
      expect(out.status).toBe(SubscriptionStatus.ACTIVE);
    });

    it('flips the attempt to PAID + upserts the subscription on success and invalidates the cache', async () => {
      const attempt = {
        id: 'pa-1',
        userId: 'user-1',
        provider: 'paystack',
        status: PaymentAttemptStatus.PENDING,
        planId: 'plan-1',
        billingInterval: BillingInterval.MONTHLY,
        amountMinor: 5000,
        amountGhs: 50,
        providerReference: 'ref_x',
        promoCodeId: null,
        discountAmount: null,
        currency: 'GHS',
        metadata: null,
      };
      paymentAttempts.findByReference.mockResolvedValueOnce(attempt);
      provider.verifyTransaction.mockResolvedValueOnce({
        status: 'success',
        amountMinor: 5000,
        customerId: 'cus_1',
      });
      // After markPaid, consumePaidAttempt calls findById to read the
      // freshly-stamped row.
      paymentAttempts.findById.mockResolvedValueOnce({
        ...attempt,
        status: PaymentAttemptStatus.PAID,
      });
      plans.getActiveForCheckout.mockResolvedValueOnce(basePlan);
      plans.cadenceFor.mockReturnValueOnce({
        providerPlanCode: 'p_monthly',
        amountMinor: 5000,
        amountDisplay: 50,
        durationDays: 30,
      });
      stubNoExistingSub();
      subsRepo.save.mockResolvedValueOnce({
        id: 'sub-new',
        userId: 'user-1',
        status: SubscriptionStatus.ACTIVE,
      } as Subscription);
      subsRepo.findOne.mockResolvedValueOnce({
        id: 'sub-new',
        userId: 'user-1',
        status: SubscriptionStatus.ACTIVE,
        plan: { account: AccountType.PRO, paymentKind: PaymentKind.RECURRING },
      } as unknown as Subscription);

      const out = await service.verify('user-1', 'ref_x');
      expect(paymentAttempts.markPaid).toHaveBeenCalledWith(
        'pa-1',
        expect.objectContaining({ providerCustomerId: 'cus_1' }),
      );
      expect(subsRepo.save).toHaveBeenCalled();
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
    // `cancel` joins SubscriptionPlan to read `payment_kind` so it can
    // refuse to cancel Plus (one-time lifetime plans). The query
    // returns rows via `getRawAndEntities` so the joined column is
    // accessible — match that shape here.
    function stubLiveSubQb(
      sub: Subscription | null,
      paymentKind: 'recurring' | 'one_time' = 'recurring',
    ) {
      subsRepo.createQueryBuilder.mockReturnValueOnce({
        innerJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawAndEntities: jest.fn().mockResolvedValue({
          entities: sub ? [sub] : [],
          raw: sub ? [{ p_payment_kind: paymentKind }] : [],
        }),
      });
    }

    it('rejects when there is no live subscription (active/trial/xp_credited)', async () => {
      stubLiveSubQb(null);
      await expect(service.cancel('user-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('refuses to cancel a Plus (one-time lifetime) subscription', async () => {
      // Plus is lifetime by contract — cancellation has no recurring
      // billing to stop and would silently drop the user to Free. The
      // service must throw BadRequest instead, so cancel buttons can
      // surface a polite "contact support" message.
      const sub = {
        id: 'plus-1',
        userId: 'user-1',
        provider: 'paystack',
        providerSubscriptionId: null,
        status: SubscriptionStatus.ACTIVE,
      } as Subscription;
      stubLiveSubQb(sub, 'one_time');
      await expect(service.cancel('user-1')).rejects.toBeInstanceOf(
        BadRequestException,
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
