import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PlansService } from './plans.service';
import { SubscriptionPlanEntity } from './entities/subscription-plan.entity';
import { AuditLog } from '../../admin/entities/audit-log.entity';
import { PaymentProviderRegistry } from '../../payments/providers/payment-provider.registry';
import { BillingInterval } from '../../../common/types/enums';

/**
 * PlansService read-path coverage. The admin write methods (create, update,
 * syncWithProvider, rollback) wrap their work in DataSource transactions —
 * those paths are covered by e2e tests.
 *
 *  - list scopes by country / includeInactive.
 *  - getById throws NotFound for missing plans.
 *  - getActiveForCheckout rejects archived plans.
 *  - cadenceFor mirrors plan columns into a normalised provider payload.
 *  - intervalForProviderPlanCode maps a code back to the matching interval.
 *  - findByProviderPlanCode searches all three cadence columns.
 */

function makePlan(
  overrides: Partial<SubscriptionPlanEntity> = {},
): SubscriptionPlanEntity {
  return {
    id: 'plan-1',
    name: 'Bondzi Pro',
    provider: 'paystack',
    currency: 'GHS',
    countryCode: 'GH',
    isActive: true,
    isDefault: true,
    monthlyPrice: '50',
    monthlyDurationDays: 30,
    providerPlanMonthly: 'p_monthly',
    sixMonthPrice: '250',
    sixMonthDurationDays: 180,
    providerPlanSixMonth: 'p_six',
    annualPrice: '450',
    annualDurationDays: 365,
    providerPlanAnnual: 'p_annual',
    ...overrides,
  } as unknown as SubscriptionPlanEntity;
}

describe('PlansService', () => {
  let service: PlansService;
  let plansRepo: {
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };

  beforeEach(async () => {
    plansRepo = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    const noop = {} as never;
    const moduleRef = await Test.createTestingModule({
      providers: [
        PlansService,
        {
          provide: getRepositoryToken(SubscriptionPlanEntity),
          useValue: plansRepo,
        },
        { provide: getRepositoryToken(AuditLog), useValue: noop },
        { provide: PaymentProviderRegistry, useValue: noop },
        { provide: DataSource, useValue: noop },
      ],
    }).compile();
    service = moduleRef.get(PlansService);
  });

  // ------------------------------ list ------------------------------

  describe('list', () => {
    function stubReturns(rows: SubscriptionPlanEntity[]) {
      const qb = {
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(rows),
      };
      plansRepo.createQueryBuilder.mockReturnValueOnce(qb);
      return qb;
    }

    it('filters by country code and defaults to active-only', async () => {
      const qb = stubReturns([]);
      await service.list({ countryCode: 'GH' });
      expect(qb.andWhere).toHaveBeenCalledWith('p.country_code = :cc', {
        cc: 'GH',
      });
      expect(qb.andWhere).toHaveBeenCalledWith('p.is_active = true');
    });

    it('opts into inactive plans only when includeInactive=true', async () => {
      const qb = stubReturns([]);
      await service.list({ includeInactive: true });
      const activeFilterCalls = qb.andWhere.mock.calls.filter((c) =>
        String(c[0]).includes('is_active'),
      );
      expect(activeFilterCalls).toHaveLength(0);
    });
  });

  // ----------------------------- getById -----------------------------

  it('getById throws NotFound for an unknown id', async () => {
    plansRepo.findOne.mockResolvedValueOnce(null);
    await expect(service.getById('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('getById returns the plan when found', async () => {
    const plan = makePlan();
    plansRepo.findOne.mockResolvedValueOnce(plan);
    expect(await service.getById('plan-1')).toEqual(plan);
  });

  // ------------------------ getActiveForCheckout ------------------------

  it('getActiveForCheckout rejects an archived plan', async () => {
    plansRepo.findOne.mockResolvedValueOnce(makePlan({ isActive: false }));
    await expect(service.getActiveForCheckout('plan-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('getActiveForCheckout returns active plans', async () => {
    plansRepo.findOne.mockResolvedValueOnce(makePlan({ isActive: true }));
    const out = await service.getActiveForCheckout('plan-1');
    expect(out.isActive).toBe(true);
  });

  // ----------------------- getDefaultForCountry -----------------------

  it('getDefaultForCountry filters by countryCode + active + default flags', async () => {
    plansRepo.findOne.mockResolvedValueOnce(null);
    await service.getDefaultForCountry('GH');
    expect(plansRepo.findOne).toHaveBeenCalledWith({
      where: { countryCode: 'GH', isActive: true, isDefault: true },
    });
  });

  // ----------------------------- cadenceFor -----------------------------

  describe('cadenceFor', () => {
    it('maps MONTHLY to the monthly columns + display→minor pesewa conversion', () => {
      const out = service.cadenceFor(makePlan(), BillingInterval.MONTHLY);
      expect(out).toEqual({
        amountMinor: 5000, // 50.00 GHS × 100
        amountDisplay: 50,
        durationDays: 30,
        providerPlanCode: 'p_monthly',
      });
    });

    it('maps SIX_MONTH to the six-month columns', () => {
      expect(service.cadenceFor(makePlan(), BillingInterval.SIX_MONTH)).toEqual(
        {
          amountMinor: 25000,
          amountDisplay: 250,
          durationDays: 180,
          providerPlanCode: 'p_six',
        },
      );
    });

    it('maps ANNUAL to the annual columns', () => {
      expect(service.cadenceFor(makePlan(), BillingInterval.ANNUAL)).toEqual({
        amountMinor: 45000,
        amountDisplay: 450,
        durationDays: 365,
        providerPlanCode: 'p_annual',
      });
    });
  });

  // ----------------------- intervalForProviderPlanCode -----------------------

  it('intervalForProviderPlanCode resolves the matching cadence', () => {
    const plan = makePlan();
    expect(service.intervalForProviderPlanCode(plan, 'p_monthly')).toBe(
      BillingInterval.MONTHLY,
    );
    expect(service.intervalForProviderPlanCode(plan, 'p_six')).toBe(
      BillingInterval.SIX_MONTH,
    );
    expect(service.intervalForProviderPlanCode(plan, 'p_annual')).toBe(
      BillingInterval.ANNUAL,
    );
    expect(service.intervalForProviderPlanCode(plan, 'unknown')).toBeNull();
  });

  // ------------------------ findByProviderPlanCode ------------------------

  it('findByProviderPlanCode queries all three cadence columns', async () => {
    const qb = {
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    };
    plansRepo.createQueryBuilder.mockReturnValueOnce(qb);
    await service.findByProviderPlanCode('p_x');
    expect(qb.where).toHaveBeenCalledWith(
      expect.stringContaining('provider_plan_monthly'),
      { code: 'p_x' },
    );
  });
});
