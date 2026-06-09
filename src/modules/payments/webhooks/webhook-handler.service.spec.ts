import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WebhookHandlerService } from './webhook-handler.service';
import { PaymentEvent } from '../entities/payment-event.entity';
import { SubscriptionsService } from '../../subscriptions/subscriptions.service';
import { PlansService } from '../../subscriptions/plans/plans.service';
import { FinancialAuditService } from '../financial-audit.service';
import { BillingLogService } from '../billing-log.service';
import { PaymentAttemptsService } from '../payment-attempts.service';
import { PaymentProviderRegistry } from '../providers/payment-provider.registry';
import {
  BillingInterval,
  BillingLogProcessStatus,
  PaymentAttemptStatus,
  SubscriptionStatus,
} from '../../../common/types/enums';
import type { NormalizedWebhookEvent } from '../providers/payment-provider.interface';

/**
 * The webhook handler is the security + correctness boundary for all
 * provider callbacks. Under the new payment_attempts trust model the
 * tests cover:
 *
 *   - Idempotency: duplicate Postgres unique-key violations short-circuit
 *     without re-firing side-effects (legacy payment_events table).
 *   - billing_log: every webhook lands a raw-payload row FIRST,
 *     processing status is back-filled afterward.
 *   - charge.success only grants entitlement when a payment_attempts
 *     row with the same reference already exists (we initiated it).
 *     Missing rows are alarmed via NO_MATCHING_PAYMENT.
 *   - subscription.disable flips status to CANCELLED on the matching row.
 *   - A handler exception is captured into BOTH the legacy payment_events
 *     row AND the billing_log row, then re-thrown so the provider retries.
 *   - Unknown event types are no-ops, not errors.
 */

function event(
  overrides: Partial<NormalizedWebhookEvent> = {},
): NormalizedWebhookEvent {
  return {
    eventId: 'evt_1',
    type: 'charge.success',
    reference: 'ref_1',
    customerId: 'cus_1',
    subscriptionId: 'sub_1',
    providerPlanCode: 'plan_code_1',
    userId: undefined,
    amountMinor: 5000,
    nextPaymentDate: undefined,
    raw: { any: 'thing' },
    ...overrides,
  } as NormalizedWebhookEvent;
}

describe('WebhookHandlerService', () => {
  let service: WebhookHandlerService;
  let eventsRepo: {
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    findOne: jest.Mock;
  };
  let subs: {
    applyWebhookActivation: jest.Mock;
    applyRefund: jest.Mock;
    findLatestByCustomer: jest.Mock;
    findLatestBySubscriptionId: jest.Mock;
    findLatestByRef: jest.Mock;
    recordPendingRenewalAttempt: jest.Mock;
    saveSubscription: jest.Mock;
    invalidateCache: jest.Mock;
  };
  let plans: {
    findByProviderPlanCode: jest.Mock;
    intervalForProviderPlanCode: jest.Mock;
    getById: jest.Mock;
  };
  let financialAudit: { record: jest.Mock };
  let billingLog: { record: jest.Mock; markProcessed: jest.Mock };
  let paymentAttempts: {
    findByReference: jest.Mock;
    findById: jest.Mock;
  };

  beforeEach(async () => {
    eventsRepo = {
      create: jest.fn((o) => o),
      save: jest.fn(),
      // Returns a resolved Promise so the `.catch(...)` chain in the
      // service's error path can run without crashing the test mock.
      update: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn(),
    };
    subs = {
      // applyWebhookActivation now returns {alarmDuplicatePlus} so the
      // caller can skip side-effects on duplicate-Plus charges. Default
      // to "happy path" (no alarm) so existing tests continue to assert
      // the receipt/financial-event chain runs.
      applyWebhookActivation: jest
        .fn()
        .mockResolvedValue({ alarmDuplicatePlus: false }),
      applyRefund: jest.fn().mockResolvedValue(null),
      findLatestByCustomer: jest.fn(),
      findLatestBySubscriptionId: jest.fn(),
      findLatestByRef: jest.fn(),
      recordPendingRenewalAttempt: jest.fn(),
      saveSubscription: jest.fn(),
      invalidateCache: jest.fn(),
    };
    plans = {
      findByProviderPlanCode: jest.fn(),
      intervalForProviderPlanCode: jest.fn(),
      getById: jest.fn(),
    };
    financialAudit = { record: jest.fn().mockResolvedValue(undefined) };
    billingLog = {
      record: jest.fn().mockResolvedValue({
        row: { id: 'log-1' },
        wasDuplicate: false,
      }),
      markProcessed: jest.fn().mockResolvedValue(undefined),
    };
    paymentAttempts = {
      findByReference: jest.fn(),
      findById: jest.fn(),
    };

    const usersRepo = { findOne: jest.fn().mockResolvedValue(null) };
    const mail = { send: jest.fn().mockResolvedValue(undefined) };
    const { User } = await import('../../users/entities/user.entity');
    const { MailService } = await import('../../mail/mail.service');

    const usersRepo = { findOne: jest.fn().mockResolvedValue(null) };
    const mail = { send: jest.fn().mockResolvedValue(undefined) };
    const { User } = await import('../../users/entities/user.entity');
    const { MailService } = await import('../../mail/mail.service');

    const moduleRef = await Test.createTestingModule({
      providers: [
        WebhookHandlerService,
        { provide: getRepositoryToken(PaymentEvent), useValue: eventsRepo },
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: SubscriptionsService, useValue: subs },
        { provide: PlansService, useValue: plans },
        { provide: FinancialAuditService, useValue: financialAudit },
        { provide: MailService, useValue: mail },
        { provide: BillingLogService, useValue: billingLog },
        { provide: PaymentAttemptsService, useValue: paymentAttempts },
        // Auto-refund path uses the provider registry to call Paystack's
        // /refund endpoint when a cancelled-sub debit lands. Default mock
        // returns `pending` so the alarm flow doesn't throw; specific
        // tests override as needed.
        {
          provide: PaymentProviderRegistry,
          useValue: {
            get: jest.fn().mockReturnValue({
              refundTransaction: jest.fn().mockResolvedValue({
                status: 'pending',
                providerRefundId: 'rf_1',
              }),
            }),
          },
        },
      ],
    }).compile();
    service = moduleRef.get(WebhookHandlerService);
  });

  // -------------------------- idempotency --------------------------

  it('returns duplicate=true without re-firing side effects when the row is already processed', async () => {
    const uniqueErr = Object.assign(new Error('duplicate'), { code: '23505' });
    eventsRepo.save.mockRejectedValueOnce(uniqueErr);
    // The existing row was already processed successfully — short-circuit.
    eventsRepo.findOne.mockResolvedValueOnce({ processed: true });

    const out = await service.process('paystack', event());

    expect(out).toEqual({ duplicate: true, processed: false });
    expect(subs.applyWebhookActivation).not.toHaveBeenCalled();
    expect(eventsRepo.update).not.toHaveBeenCalled();
    // We DO write to billing_log for every inbound event so the
    // forensic record is complete — even on the duplicate short-
    // circuit. The row is marked DUPLICATE so admins can filter to
    // already-processed replays separately from the success stream.
    expect(billingLog.record).toHaveBeenCalled();
    expect(billingLog.markProcessed).toHaveBeenCalledWith(
      'log-1',
      BillingLogProcessStatus.DUPLICATE,
      expect.objectContaining({ error: expect.any(String) }),
    );
  });

  it('re-processes when the existing row is processed=false (provider retry of a previously failed event)', async () => {
    // First delivery hit a transient error and left processed=false.
    // The provider retries; same event id arrives again. The unique-key
    // violation is caught, the existing unprocessed row is detected,
    // and dispatch is re-attempted (this time successfully).
    const uniqueErr = Object.assign(new Error('duplicate'), { code: '23505' });
    eventsRepo.save.mockRejectedValueOnce(uniqueErr);
    eventsRepo.findOne.mockResolvedValueOnce({ processed: false });
    paymentAttempts.findByReference.mockResolvedValueOnce({
      id: 'pa-1',
      userId: 'user-1',
      status: PaymentAttemptStatus.PENDING,
      billingInterval: BillingInterval.MONTHLY,
    });
    paymentAttempts.findById.mockResolvedValueOnce({
      id: 'pa-1',
      subscriptionId: 'sub-after',
    });
    plans.findByProviderPlanCode.mockResolvedValueOnce({ id: 'plan-1' });
    plans.intervalForProviderPlanCode.mockReturnValueOnce(
      BillingInterval.MONTHLY,
    );

    const out = await service.process('paystack', event());

    expect(subs.applyWebhookActivation).toHaveBeenCalled();
    expect(eventsRepo.update).toHaveBeenCalledWith(
      { provider: 'paystack', providerEventId: 'evt_1' },
      expect.objectContaining({ processed: true }),
    );
    expect(out.processed).toBe(true);
  });

  it('rethrows DB errors that are not unique-key violations', async () => {
    eventsRepo.save.mockRejectedValueOnce(new Error('pool exhausted'));
    await expect(service.process('paystack', event())).rejects.toThrow(
      'pool exhausted',
    );
  });

  // -------------------- billing_log --------------------

  it('writes a billing_log row before dispatching, marks SUCCESS afterwards', async () => {
    eventsRepo.save.mockResolvedValueOnce({});
    paymentAttempts.findByReference.mockResolvedValueOnce({
      id: 'pa-1',
      userId: 'user-1',
      status: PaymentAttemptStatus.PENDING,
      billingInterval: BillingInterval.MONTHLY,
    });
    paymentAttempts.findById.mockResolvedValueOnce({
      id: 'pa-1',
      subscriptionId: 'sub-after',
    });
    plans.findByProviderPlanCode.mockResolvedValueOnce({ id: 'plan-1' });
    plans.intervalForProviderPlanCode.mockReturnValueOnce(
      BillingInterval.MONTHLY,
    );

    await service.process('paystack', event());

    expect(billingLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'paystack',
        providerEventId: 'evt_1',
        eventType: 'charge.success',
        reference: 'ref_1',
        rawPayload: { any: 'thing' },
      }),
    );
    expect(billingLog.markProcessed).toHaveBeenCalledWith(
      'log-1',
      BillingLogProcessStatus.SUCCESS,
      expect.objectContaining({ paymentAttemptId: 'pa-1' }),
    );
  });

  // -------------------- charge.success → activation --------------------

  describe('charge.success', () => {
    it('activates the subscription when a matching payment_attempt + plan resolve', async () => {
      eventsRepo.save.mockResolvedValueOnce({});
      paymentAttempts.findByReference.mockResolvedValueOnce({
        id: 'pa-1',
        userId: 'user-1',
        status: PaymentAttemptStatus.PENDING,
        billingInterval: BillingInterval.MONTHLY,
      });
      paymentAttempts.findById.mockResolvedValueOnce({
        id: 'pa-1',
        subscriptionId: 'sub-after',
      });
      plans.findByProviderPlanCode.mockResolvedValueOnce({ id: 'plan-1' });
      plans.intervalForProviderPlanCode.mockReturnValueOnce(
        BillingInterval.MONTHLY,
      );

      const out = await service.process('paystack', event());

      expect(subs.applyWebhookActivation).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          plan: { id: 'plan-1' },
          interval: BillingInterval.MONTHLY,
          providerReference: 'ref_1',
          amountDisplay: 50, // 5000 minor → 50.00 display
        }),
      );
      expect(eventsRepo.update).toHaveBeenCalledWith(
        { provider: 'paystack', providerEventId: 'evt_1' },
        expect.objectContaining({ processed: true }),
      );
      expect(out).toEqual({ duplicate: false, processed: true });
    });

    it('ALARMS no_matching_payment when no payment_attempt exists for the reference and it is not a renewal', async () => {
      eventsRepo.save.mockResolvedValueOnce({});
      paymentAttempts.findByReference.mockResolvedValueOnce(null);
      subs.findLatestBySubscriptionId.mockResolvedValueOnce(null);

      const out = await service.process('paystack', event());

      expect(subs.applyWebhookActivation).not.toHaveBeenCalled();
      expect(billingLog.markProcessed).toHaveBeenCalledWith(
        'log-1',
        BillingLogProcessStatus.NO_MATCHING_PAYMENT,
        expect.objectContaining({
          error: expect.stringContaining('no matching payment_attempt'),
        }),
      );
      // The legacy payment_events row still flips to processed=true so
      // Paystack doesn't retry forever on an alarm event.
      expect(out.processed).toBe(true);
    });

    it('treats charge.success with no matching attempt but an ACTIVE recurring subscription as a Pro auto-renewal', async () => {
      eventsRepo.save.mockResolvedValueOnce({});
      paymentAttempts.findByReference.mockResolvedValueOnce(null);
      subs.findLatestBySubscriptionId.mockResolvedValueOnce({
        id: 'sub-1',
        userId: 'user-1',
        planId: 'plan-1',
        billingInterval: BillingInterval.MONTHLY,
        status: SubscriptionStatus.ACTIVE,
      });
      plans.getById.mockResolvedValueOnce({
        id: 'plan-1',
        paymentKind: 'recurring',
      });
      subs.recordPendingRenewalAttempt.mockResolvedValueOnce({
        id: 'pa-renewal',
        userId: 'user-1',
      });
      paymentAttempts.findById.mockResolvedValueOnce({
        id: 'pa-renewal',
        subscriptionId: 'sub-1',
      });
      plans.findByProviderPlanCode.mockResolvedValueOnce({
        id: 'plan-1',
        paymentKind: 'recurring',
      });
      plans.intervalForProviderPlanCode.mockReturnValueOnce(
        BillingInterval.MONTHLY,
      );

      await service.process('paystack', event());

      expect(subs.recordPendingRenewalAttempt).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          planId: 'plan-1',
          providerReference: 'ref_1',
          providerSubscriptionId: 'sub_1',
        }),
      );
      expect(subs.applyWebhookActivation).toHaveBeenCalled();
    });

    it('REFUSES to treat charge.success as a renewal when the existing sub is CANCELLED (alarm path)', async () => {
      // Defends against Paystack auto-debiting after we already
      // cancelled — without this guard the renewal branch would
      // resurrect the cancelled sub and re-bill the user.
      eventsRepo.save.mockResolvedValueOnce({});
      paymentAttempts.findByReference.mockResolvedValueOnce(null);
      subs.findLatestBySubscriptionId.mockResolvedValueOnce({
        id: 'sub-1',
        userId: 'user-1',
        planId: 'plan-1',
        billingInterval: BillingInterval.MONTHLY,
        status: SubscriptionStatus.CANCELLED,
      });

      await service.process('paystack', event());

      expect(subs.recordPendingRenewalAttempt).not.toHaveBeenCalled();
      expect(subs.applyWebhookActivation).not.toHaveBeenCalled();
      expect(billingLog.markProcessed).toHaveBeenCalledWith(
        'log-1',
        BillingLogProcessStatus.NO_MATCHING_PAYMENT,
        expect.objectContaining({
          error: expect.stringContaining('no matching payment_attempt'),
        }),
      );
    });

    it('REFUSES to treat charge.success as a renewal when the existing sub is on a ONE_TIME plan', async () => {
      // Provider-bug defense: a one-time Plus charge that somehow
      // carries a subscription_code must NOT be fed into the renewal
      // path — consumePaidAttempt would then throw "Recurring payments
      // require a billing interval" and Paystack would retry forever.
      eventsRepo.save.mockResolvedValueOnce({});
      paymentAttempts.findByReference.mockResolvedValueOnce(null);
      subs.findLatestBySubscriptionId.mockResolvedValueOnce({
        id: 'sub-plus',
        userId: 'user-1',
        planId: 'plan-plus',
        billingInterval: null,
        status: SubscriptionStatus.ACTIVE,
      });
      plans.getById.mockResolvedValueOnce({
        id: 'plan-plus',
        paymentKind: 'one_time',
      });

      await service.process('paystack', event());

      expect(subs.recordPendingRenewalAttempt).not.toHaveBeenCalled();
      expect(subs.applyWebhookActivation).not.toHaveBeenCalled();
    });

    it('SKIPS receipt + financial-event ACTIVATION on the duplicate-Plus alarm path', async () => {
      eventsRepo.save.mockResolvedValueOnce({});
      paymentAttempts.findByReference.mockResolvedValueOnce({
        id: 'pa-1',
        userId: 'user-1',
        status: PaymentAttemptStatus.PENDING,
        billingInterval: null,
      });
      paymentAttempts.findById.mockResolvedValueOnce({
        id: 'pa-1',
        subscriptionId: 'sub-existing',
      });
      plans.findByProviderPlanCode.mockResolvedValueOnce({
        id: 'plan-plus',
        paymentKind: 'one_time',
      });
      subs.applyWebhookActivation.mockResolvedValueOnce({
        alarmDuplicatePlus: true,
      });

      await service.process('paystack', event());

      expect(financialAudit.record).not.toHaveBeenCalled();
      expect(billingLog.markProcessed).toHaveBeenCalledWith(
        'log-1',
        BillingLogProcessStatus.NO_MATCHING_PAYMENT,
        expect.objectContaining({
          error: expect.stringContaining('duplicate_plus_charge'),
        }),
      );
    });

    it('silently skips when the plan cannot be matched even with an attempt present', async () => {
      eventsRepo.save.mockResolvedValueOnce({});
      paymentAttempts.findByReference.mockResolvedValueOnce({
        id: 'pa-1',
        userId: 'user-1',
        status: PaymentAttemptStatus.PENDING,
        billingInterval: BillingInterval.MONTHLY,
      });
      plans.findByProviderPlanCode.mockResolvedValueOnce(null);
      subs.findLatestByRef.mockResolvedValueOnce(null);
      subs.findLatestByCustomer.mockResolvedValueOnce(null);

      await service.process('paystack', event());

      expect(subs.applyWebhookActivation).not.toHaveBeenCalled();
    });
  });

  // -------------------- subscription.disable --------------------

  it('subscription.disable flips status to CANCELLED on the matching row', async () => {
    eventsRepo.save.mockResolvedValueOnce({});
    const sub = { userId: 'user-1', status: SubscriptionStatus.ACTIVE };
    subs.findLatestBySubscriptionId.mockResolvedValueOnce(sub);

    await service.process('paystack', event({ type: 'subscription.disable' }));

    expect(sub.status).toBe(SubscriptionStatus.CANCELLED);
    expect(subs.saveSubscription).toHaveBeenCalledWith(sub);
    expect(subs.invalidateCache).toHaveBeenCalledWith('user-1');
  });

  // -------------------- invoice.failed --------------------

  it('invoice.failed does NOT change subscription status — Paystack retries on its own schedule, access lapses at expires_at', async () => {
    // Previously this handler flipped status to PAST_DUE, which sits
    // outside entitlementFor's active set — so the user lost Pro on
    // the FIRST retry-failed webhook even though they had prepaid
    // time left. The refactor leaves the row alone; the natural
    // expires_at expiry is the access boundary.
    eventsRepo.save.mockResolvedValueOnce({});
    const sub = {
      id: 'sub-1',
      userId: 'user-1',
      planId: 'plan-1',
      status: SubscriptionStatus.ACTIVE,
      expiresAt: new Date(Date.now() + 86400_000),
    };
    subs.findLatestBySubscriptionId.mockResolvedValueOnce(sub);
    // dispatchPaymentFailedEmail resolves the plan to build the
    // template; return a stub so the .catch() chain doesn't blow up.
    plans.getById.mockResolvedValueOnce({
      id: 'plan-1',
      name: 'Pro WASSCE',
      level: 'wassce',
    });

    await service.process('paystack', event({ type: 'invoice.failed' }));

    expect(sub.status).toBe(SubscriptionStatus.ACTIVE);
    expect(subs.saveSubscription).not.toHaveBeenCalled();
    // Audit row IS written so admin can see the failed-renewal event.
    expect(financialAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          kind: 'invoice_failed_no_status_change',
        }),
      }),
    );
  });

  // -------------------- error capture --------------------

  it('throws on dispatch failure so the controller returns 5xx and the provider retries', async () => {
    // CRITICAL: the previous shape silently returned 200 on processing
    // failure → Paystack never retried → user paid, no premium granted.
    // The fix is to record the error on the row AND throw so the HTTP
    // layer returns 5xx. The provider retries; the unique-key violation
    // on the second delivery routes through the "retry unprocessed row"
    // branch above.
    eventsRepo.save.mockResolvedValueOnce({});
    paymentAttempts.findByReference.mockResolvedValueOnce({
      id: 'pa-1',
      userId: 'user-1',
      status: PaymentAttemptStatus.PENDING,
      billingInterval: BillingInterval.MONTHLY,
    });
    plans.findByProviderPlanCode.mockResolvedValueOnce({ id: 'plan-1' });
    plans.intervalForProviderPlanCode.mockReturnValueOnce(
      BillingInterval.MONTHLY,
    );
    subs.applyWebhookActivation.mockRejectedValueOnce(new Error('db down'));

    await expect(service.process('paystack', event())).rejects.toThrow(
      /Webhook processing failed/,
    );
    expect(eventsRepo.update).toHaveBeenCalledWith(
      { provider: 'paystack', providerEventId: 'evt_1' },
      expect.objectContaining({ error: 'db down' }),
    );
    expect(billingLog.markProcessed).toHaveBeenCalledWith(
      'log-1',
      BillingLogProcessStatus.ERROR,
      expect.objectContaining({ error: 'db down' }),
    );
  });

  // -------------------- unknown event types --------------------

  it('unknown event types are recorded but produce no side effects', async () => {
    eventsRepo.save.mockResolvedValueOnce({});
    const out = await service.process(
      'paystack',
      event({ type: 'something.weird' as never }),
    );
    expect(out.processed).toBe(true);
    expect(subs.applyWebhookActivation).not.toHaveBeenCalled();
    expect(subs.saveSubscription).not.toHaveBeenCalled();
  });
});
