import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WebhookHandlerService } from './webhook-handler.service';
import { PaymentEvent } from '../entities/payment-event.entity';
import { SubscriptionsService } from '../../subscriptions/subscriptions.service';
import { PlansService } from '../../subscriptions/plans/plans.service';
import {
  BillingInterval,
  SubscriptionStatus,
} from '../../../common/types/enums';
import type { NormalizedWebhookEvent } from '../providers/payment-provider.interface';

/**
 * The webhook handler is the security + correctness boundary for all
 * provider callbacks. The tests below cover the things a regression would
 * cause real money problems:
 *   - Idempotency: duplicate Postgres unique-key violations short-circuit
 *     without re-firing side-effects.
 *   - charge.success activates the subscription only when user + plan +
 *     interval all resolve.
 *   - subscription.disable flips status to CANCELLED.
 *   - A handler exception is captured into the payment_events row but
 *     still returns processed: false (the controller always responds 200).
 *   - Unknown event types are no-ops, not errors.
 */

function event(overrides: Partial<NormalizedWebhookEvent> = {}): NormalizedWebhookEvent {
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
  let eventsRepo: { create: jest.Mock; save: jest.Mock; update: jest.Mock };
  let subs: {
    applyWebhookActivation: jest.Mock;
    findLatestByCustomer: jest.Mock;
    findLatestBySubscriptionId: jest.Mock;
    findLatestByRef: jest.Mock;
    saveSubscription: jest.Mock;
    invalidateCache: jest.Mock;
  };
  let plans: {
    findByProviderPlanCode: jest.Mock;
    intervalForProviderPlanCode: jest.Mock;
    getById: jest.Mock;
  };

  beforeEach(async () => {
    eventsRepo = {
      create: jest.fn((o) => o),
      save: jest.fn(),
      update: jest.fn(),
    };
    subs = {
      applyWebhookActivation: jest.fn(),
      findLatestByCustomer: jest.fn(),
      findLatestBySubscriptionId: jest.fn(),
      findLatestByRef: jest.fn(),
      saveSubscription: jest.fn(),
      invalidateCache: jest.fn(),
    };
    plans = {
      findByProviderPlanCode: jest.fn(),
      intervalForProviderPlanCode: jest.fn(),
      getById: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        WebhookHandlerService,
        { provide: getRepositoryToken(PaymentEvent), useValue: eventsRepo },
        { provide: SubscriptionsService, useValue: subs },
        { provide: PlansService, useValue: plans },
      ],
    }).compile();
    service = moduleRef.get(WebhookHandlerService);
  });

  // -------------------------- idempotency --------------------------

  it('returns duplicate=true without re-firing side effects on UNIQUE violation', async () => {
    const uniqueErr = Object.assign(new Error('duplicate'), { code: '23505' });
    eventsRepo.save.mockRejectedValueOnce(uniqueErr);

    const out = await service.process('paystack', event());

    expect(out).toEqual({ duplicate: true, processed: false });
    expect(subs.applyWebhookActivation).not.toHaveBeenCalled();
    expect(eventsRepo.update).not.toHaveBeenCalled();
  });

  it('rethrows DB errors that are not unique-key violations', async () => {
    eventsRepo.save.mockRejectedValueOnce(new Error('pool exhausted'));
    await expect(service.process('paystack', event())).rejects.toThrow(
      'pool exhausted',
    );
  });

  // -------------------- charge.success → activation --------------------

  describe('charge.success', () => {
    it('activates the subscription when user + plan + interval resolve', async () => {
      eventsRepo.save.mockResolvedValueOnce({});
      subs.findLatestByRef.mockResolvedValueOnce({ userId: 'user-1' });
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

    it('silently skips when no user can be resolved (event still recorded)', async () => {
      eventsRepo.save.mockResolvedValueOnce({});
      subs.findLatestByRef.mockResolvedValueOnce(null);
      subs.findLatestByCustomer.mockResolvedValueOnce(null);

      const out = await service.process(
        'paystack',
        event({ userId: undefined }),
      );

      expect(subs.applyWebhookActivation).not.toHaveBeenCalled();
      expect(out.processed).toBe(true);
    });

    it('silently skips when the plan cannot be matched', async () => {
      eventsRepo.save.mockResolvedValueOnce({});
      subs.findLatestByRef.mockResolvedValueOnce({ userId: 'user-1' });
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

    await service.process(
      'paystack',
      event({ type: 'subscription.disable' }),
    );

    expect(sub.status).toBe(SubscriptionStatus.CANCELLED);
    expect(subs.saveSubscription).toHaveBeenCalledWith(sub);
    expect(subs.invalidateCache).toHaveBeenCalledWith('user-1');
  });

  // -------------------- invoice.failed → PAST_DUE --------------------

  it('invoice.failed flips status to PAST_DUE', async () => {
    eventsRepo.save.mockResolvedValueOnce({});
    const sub = { userId: 'user-1', status: SubscriptionStatus.ACTIVE };
    subs.findLatestBySubscriptionId.mockResolvedValueOnce(sub);

    await service.process('paystack', event({ type: 'invoice.failed' }));

    expect(sub.status).toBe(SubscriptionStatus.PAST_DUE);
  });

  // -------------------- error capture --------------------

  it('captures handler errors into payment_events.error and still returns processed=false', async () => {
    eventsRepo.save.mockResolvedValueOnce({});
    subs.findLatestByRef.mockResolvedValueOnce({ userId: 'user-1' });
    plans.findByProviderPlanCode.mockResolvedValueOnce({ id: 'plan-1' });
    plans.intervalForProviderPlanCode.mockReturnValueOnce(
      BillingInterval.MONTHLY,
    );
    subs.applyWebhookActivation.mockRejectedValueOnce(new Error('db down'));

    const out = await service.process('paystack', event());

    expect(out).toEqual({ duplicate: false, processed: false });
    expect(eventsRepo.update).toHaveBeenCalledWith(
      { provider: 'paystack', providerEventId: 'evt_1' },
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
