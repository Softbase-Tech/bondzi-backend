import axios from 'axios';
import { DataSource } from 'typeorm';
import { SubscriptionPlanEntity } from '../../modules/subscriptions/plans/entities/subscription-plan.entity';

interface SeedCadence {
  cadence: 'monthly' | 'six_month' | 'annual';
  paystackInterval: 'monthly' | 'biannually' | 'annually';
  amountMinor: number;
}

/**
 * Seeds the default "Bondzi Pro GH" plan (monthly ₵29, six-month ₵150,
 * annual ₵240). Idempotent — skips if any plan row already exists.
 *
 * If PAYSTACK_SECRET_KEY_GH is present the seeder creates the three cadence
 * plans on Paystack and persists the returned codes. Without it, the plan is
 * inserted with null codes and an admin must run POST /admin/plans/:id/sync
 * to wire Paystack up later.
 */
export async function seedSubscriptionPlans(ds: DataSource): Promise<void> {
  const repo = ds.getRepository(SubscriptionPlanEntity);
  const existing = await repo.count();
  if (existing > 0) {
    console.log('[seed] subscription_plan already has rows — skipping');
    return;
  }

  const plan = repo.create({
    name: 'Bondzi Pro GH',
    description: 'Full access to Bondzi Ghana premium features.',
    countryCode: 'GH',
    currency: 'GHS',
    provider: 'paystack',
    monthlyPrice: 29.0,
    sixMonthPrice: 150.0,
    annualPrice: 240.0,
    monthlyDurationDays: 30,
    sixMonthDurationDays: 180,
    annualDurationDays: 365,
    isActive: true,
    isDefault: true,
    version: 1,
    parentPlanId: null,
  });
  const saved = await repo.save(plan);

  const secret = process.env.PAYSTACK_SECRET_KEY_GH;
  if (!secret) {
    console.log(
      '[seed] PAYSTACK_SECRET_KEY_GH not set — plan rows stored with null codes. Run POST /admin/plans/:id/sync once credentials are available.',
    );
    return;
  }

  const cadences: SeedCadence[] = [
    { cadence: 'monthly', paystackInterval: 'monthly', amountMinor: 2900 },
    {
      cadence: 'six_month',
      paystackInterval: 'biannually',
      amountMinor: 15000,
    },
    { cadence: 'annual', paystackInterval: 'annually', amountMinor: 24000 },
  ];

  const http = axios.create({
    baseURL: 'https://api.paystack.co',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    timeout: 10_000,
  });

  const codes: Record<SeedCadence['cadence'], string | null> = {
    monthly: null,
    six_month: null,
    annual: null,
  };

  for (const c of cadences) {
    try {
      const res = await http.post<{ data: { plan_code: string } }>('/plan', {
        name: `Bondzi Pro GH • ${c.cadence}`,
        amount: c.amountMinor,
        interval: c.paystackInterval,
        currency: 'GHS',
      });
      codes[c.cadence] = res.data.data.plan_code;
    } catch (err) {
      console.warn(
        `[seed] failed to create Paystack ${c.cadence} plan: ${(err as Error).message}`,
      );
    }
  }

  await repo.update(saved.id, {
    providerPlanMonthly: codes.monthly,
    providerPlanSixMonth: codes.six_month,
    providerPlanAnnual: codes.annual,
  });

  console.log(
    `[seed] seeded plan "Bondzi Pro GH" (paystack codes: monthly=${codes.monthly ?? 'null'}, six_month=${codes.six_month ?? 'null'}, annual=${codes.annual ?? 'null'})`,
  );
}
