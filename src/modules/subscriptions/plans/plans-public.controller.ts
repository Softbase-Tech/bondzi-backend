import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/decorators/public.decorator';
import { PlansService } from './plans.service';
import { SubscriptionPlanEntity } from './entities/subscription-plan.entity';

interface PublicPlanView {
  id: string;
  name: string;
  description: string | null;
  countryCode: string;
  currency: string;
  isDefault: boolean;
  pricing: {
    monthly: CadenceView;
    sixMonth: CadenceView;
    annual: CadenceView;
  };
}

interface CadenceView {
  price: number;
  durationDays: number;
  available: boolean; // true iff a provider plan code exists for this cadence
}

/**
 * Mobile/client-facing plan catalogue. Only active plans are returned; the
 * `available` flag on each cadence tells clients whether checkout is wired
 * up yet (e.g. a plan created with syncProvider=false will show
 * available=false until an admin runs the sync endpoint).
 */
@ApiTags('plans')
@Controller('plans')
export class PlansPublicController {
  constructor(private readonly plans: PlansService) {}

  @Public()
  @Get()
  @ApiOperation({
    summary:
      'List active plans for the given country (default GH). Each plan exposes monthly / six-month / annual pricing.',
  })
  async list(@Query('country') country?: string): Promise<PublicPlanView[]> {
    const rows = await this.plans.list({
      countryCode: country,
      includeInactive: false,
    });
    return rows.map((r) => this.toView(r));
  }

  private toView(plan: SubscriptionPlanEntity): PublicPlanView {
    return {
      id: plan.id,
      name: plan.name,
      description: plan.description,
      countryCode: plan.countryCode,
      currency: plan.currency,
      isDefault: plan.isDefault,
      pricing: {
        monthly: {
          price: plan.monthlyPrice,
          durationDays: plan.monthlyDurationDays,
          available: plan.providerPlanMonthly !== null,
        },
        sixMonth: {
          price: plan.sixMonthPrice,
          durationDays: plan.sixMonthDurationDays,
          available: plan.providerPlanSixMonth !== null,
        },
        annual: {
          price: plan.annualPrice,
          durationDays: plan.annualDurationDays,
          available: plan.providerPlanAnnual !== null,
        },
      },
    };
  }
}
