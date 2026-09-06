import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  BillingInterval,
  PaymentAttemptStatus,
  PaymentKind,
} from '../../common/types/enums';
import { PaymentReconcileService } from './payment-reconcile.service';
import { PaymentAttemptsService } from './payment-attempts.service';
import { PaymentProviderRegistry } from './providers/payment-provider.registry';
import { PlansService } from '../subscriptions/plans/plans.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { User } from '../users/entities/user.entity';

/**
 * The reconcile tool's contract: it may only pull money into the books
 * through the same verify path a normal checkout uses, and only when
 * the transaction verifies at Paystack AND the amount matches the
 * catalogue exactly. These tests pin the guard rails.
 */
describe('PaymentReconcileService', () => {
  const ADMIN = 'admin-1';
  const REF = 'T392794704738743';
  const USER_ID = '9ebb9859-0000-0000-0000-000000000000';
  const PLAN_ID = 'b1b1b1b1-0000-0000-0000-000000000000';

  const proPlan = {
    id: PLAN_ID,
    name: 'Pro · WASSCE',
    account: 'pro',
    level: 'wassce',
    paymentKind: PaymentKind.RECURRING,
    currency: 'GHS',
    monthlyPrice: 29,
    sixMonthPrice: 150,
    annualPrice: 240,
  };

  let usersRepo: { findOne: jest.Mock };
  let attempts: { findByReference: jest.Mock; createPending: jest.Mock };
  let provider: { verifyTransaction: jest.Mock };
  let subs: { verify: jest.Mock };
  let plans: { getById: jest.Mock; findByProviderPlanCode: jest.Mock };
  let service: PaymentReconcileService;

  beforeEach(async () => {
    usersRepo = { findOne: jest.fn().mockResolvedValue({ id: USER_ID }) };
    attempts = {
      findByReference: jest.fn().mockResolvedValue(null),
      createPending: jest.fn().mockResolvedValue({ id: 'attempt-1' }),
    };
    provider = {
      verifyTransaction: jest.fn().mockResolvedValue({
        status: 'success',
        reference: REF,
        amountMinor: 2900,
        currency: 'GHS',
        customerId: 'CUS_x',
        providerPlanCode: null,
        raw: {
          customer: { email: 'student@example.com' },
          metadata: { planId: PLAN_ID, cadence: 'monthly' },
        },
      }),
    };
    subs = { verify: jest.fn().mockResolvedValue({ id: 'sub-1' }) };
    plans = {
      getById: jest.fn().mockResolvedValue(proPlan),
      findByProviderPlanCode: jest.fn().mockResolvedValue(null),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentReconcileService,
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: PaymentAttemptsService, useValue: attempts },
        {
          provide: PaymentProviderRegistry,
          useValue: { get: jest.fn(() => provider) },
        },
        { provide: SubscriptionsService, useValue: subs },
        { provide: PlansService, useValue: plans },
      ],
    }).compile();
    service = moduleRef.get(PaymentReconcileService);
  });

  it('reconciles a foreign reference: synthesises the attempt at catalogue price and drives subs.verify', async () => {
    const res = await service.reconcile(ADMIN, { reference: REF });

    expect(res.outcome).toBe('reconciled');
    expect(attempts.createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        planId: PLAN_ID,
        billingInterval: BillingInterval.MONTHLY,
        amountMinor: 2900,
        providerReference: REF,
        metadata: expect.objectContaining({
          source: 'admin_reconcile',
          reconciledByAdminId: ADMIN,
        }),
      }),
    );
    expect(subs.verify).toHaveBeenCalledWith(USER_ID, REF);
  });

  it('resolves the user by customer email when metadata carries no userId', async () => {
    provider.verifyTransaction.mockResolvedValue({
      status: 'success',
      reference: REF,
      amountMinor: 2900,
      currency: 'GHS',
      customerId: 'CUS_x',
      providerPlanCode: null,
      raw: {
        customer: { email: 'Student@Example.com ' },
        metadata: { planId: PLAN_ID, cadence: 'monthly' },
      },
    });
    await service.reconcile(ADMIN, { reference: REF });
    expect(usersRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: 'student@example.com' },
      }),
    );
  });

  it('is idempotent: PAID + linked attempt returns already_recorded without touching anything', async () => {
    attempts.findByReference.mockResolvedValue({
      id: 'attempt-1',
      userId: USER_ID,
      planId: PLAN_ID,
      status: PaymentAttemptStatus.PAID,
      subscriptionId: 'sub-1',
      billingInterval: BillingInterval.MONTHLY,
      amountMinor: 2900,
    });
    const res = await service.reconcile(ADMIN, { reference: REF });
    expect(res.outcome).toBe('already_recorded');
    expect(subs.verify).not.toHaveBeenCalled();
    expect(attempts.createPending).not.toHaveBeenCalled();
  });

  it('drives an existing PENDING attempt through verify (verified_existing)', async () => {
    attempts.findByReference.mockResolvedValue({
      id: 'attempt-1',
      userId: USER_ID,
      planId: PLAN_ID,
      status: PaymentAttemptStatus.PENDING,
      subscriptionId: null,
      billingInterval: BillingInterval.MONTHLY,
      amountMinor: 2900,
    });
    const res = await service.reconcile(ADMIN, { reference: REF });
    expect(res.outcome).toBe('verified_existing');
    expect(subs.verify).toHaveBeenCalledWith(USER_ID, REF);
    expect(attempts.createPending).not.toHaveBeenCalled();
  });

  it('REFUSES an amount that does not match the catalogue price', async () => {
    provider.verifyTransaction.mockResolvedValue({
      status: 'success',
      reference: REF,
      amountMinor: 1500,
      currency: 'GHS',
      customerId: 'CUS_x',
      providerPlanCode: null,
      raw: {
        customer: { email: 'student@example.com' },
        metadata: { planId: PLAN_ID, cadence: 'monthly' },
      },
    });
    await expect(service.reconcile(ADMIN, { reference: REF })).rejects.toThrow(
      ConflictException,
    );
    expect(attempts.createPending).not.toHaveBeenCalled();
    expect(subs.verify).not.toHaveBeenCalled();
  });

  it('REFUSES a transaction that is not successful at Paystack', async () => {
    provider.verifyTransaction.mockResolvedValue({
      status: 'failed',
      reference: REF,
      amountMinor: 2900,
      currency: 'GHS',
      customerId: null,
      providerPlanCode: null,
      raw: {},
    });
    await expect(service.reconcile(ADMIN, { reference: REF })).rejects.toThrow(
      ConflictException,
    );
  });

  it('404s when Paystack does not recognise the reference', async () => {
    provider.verifyTransaction.mockRejectedValue(new Error('404'));
    await expect(service.reconcile(ADMIN, { reference: REF })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('rejects when the user cannot be identified, asking for an explicit userId', async () => {
    usersRepo.findOne.mockResolvedValue(null);
    await expect(service.reconcile(ADMIN, { reference: REF })).rejects.toThrow(
      UnprocessableEntityException,
    );
    expect(attempts.createPending).not.toHaveBeenCalled();
  });

  it('requires an interval for recurring plans when metadata has none', async () => {
    provider.verifyTransaction.mockResolvedValue({
      status: 'success',
      reference: REF,
      amountMinor: 2900,
      currency: 'GHS',
      customerId: 'CUS_x',
      providerPlanCode: null,
      raw: {
        customer: { email: 'student@example.com' },
        metadata: { planId: PLAN_ID },
      },
    });
    await expect(service.reconcile(ADMIN, { reference: REF })).rejects.toThrow(
      UnprocessableEntityException,
    );
  });
});
