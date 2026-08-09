import { Test } from '@nestjs/testing';
import { PlansPublicController } from './plans-public.controller';
import { PlansService } from './plans.service';

/**
 * PlansPublicController.list shapes the SubscriptionPlanEntity into the wire
 * payload the mobile catalogue reads. The non-obvious contract is the
 * `available` flag on each cadence: it must be `true` iff the provider plan
 * code is present (not null), otherwise the client hides that cadence button.
 */

describe('PlansPublicController', () => {
  let controller: PlansPublicController;
  let plans: { list: jest.Mock };

  beforeEach(async () => {
    plans = { list: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      controllers: [PlansPublicController],
      providers: [{ provide: PlansService, useValue: plans }],
    }).compile();
    controller = moduleRef.get(PlansPublicController);
  });

  it('passes includeInactive=false to the service (only active plans on mobile)', async () => {
    plans.list.mockResolvedValueOnce([]);
    await controller.list('GH');
    expect(plans.list).toHaveBeenCalledWith({
      countryCode: 'GH',
      includeInactive: false,
    });
  });

  it('available=false on a cadence whose provider plan code is null', async () => {
    plans.list.mockResolvedValueOnce([
      {
        id: 'p-1',
        name: 'Bondzi Plus',
        description: 'desc',
        countryCode: 'GH',
        currency: 'GHS',
        isDefault: true,
        monthlyPrice: 30,
        sixMonthPrice: 150,
        annualPrice: 270,
        monthlyDurationDays: 30,
        sixMonthDurationDays: 180,
        annualDurationDays: 365,
        providerPlanMonthly: 'PLN-M',
        providerPlanSixMonth: null,
        providerPlanAnnual: 'PLN-Y',
      },
    ]);
    const out = await controller.list('GH');
    expect(out[0].pricing.monthly.available).toBe(true);
    expect(out[0].pricing.sixMonth.available).toBe(false);
    expect(out[0].pricing.annual.available).toBe(true);
  });

  it('returns pricing as numbers (transformer coerces at the entity layer)', async () => {
    // The numericTransformer on the entity columns means the values
    // arrive here already-coerced; this test guarantees the controller
    // doesn't re-stringify them on the way out.
    plans.list.mockResolvedValueOnce([
      {
        id: 'p-1',
        name: 'X',
        description: null,
        countryCode: 'GH',
        currency: 'GHS',
        isDefault: false,
        monthlyPrice: 30,
        sixMonthPrice: 150,
        annualPrice: 270,
        monthlyDurationDays: 30,
        sixMonthDurationDays: 180,
        annualDurationDays: 365,
        providerPlanMonthly: 'M',
        providerPlanSixMonth: 'S',
        providerPlanAnnual: 'A',
      },
    ]);
    const out = await controller.list();
    expect(out[0].pricing.monthly.price).toBe(30);
    expect(typeof out[0].pricing.monthly.price).toBe('number');
  });
});
