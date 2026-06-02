import axios from 'axios';
import { DataSource } from 'typeorm';
import { SubscriptionPlanEntity } from '../../modules/subscriptions/plans/entities/subscription-plan.entity';
import {
  AccountType,
  ExamType,
  PaymentKind,
} from '../../common/types/enums';

/**
 * Seeds the six default subscription plans — one row per
 * (account × level) slot:
 *
 *     Plus × BECE         Plus × WASSCE        Plus × NOVDEC
 *     Pro  × BECE         Pro  × WASSCE        Pro  × NOVDEC
 *
 * Plus is a one-time charge (`payment_kind = one_time`, lifetime grant,
 * `expires_at = NULL` on the resulting subscription row). Pro is a
 * recurring subscription with monthly / six-month / annual cadences.
 *
 * Prices are VAT-INCLUSIVE (Ghana 15%): a `monthlyPrice` of 200.00 means
 * the student pays exactly 200.00 GHS at checkout; the receipt breaks
 * the figure down into ~173.91 net + ~26.09 VAT. Admin edits prices via
 * the admin panel — these seed values are launch defaults only.
 *
 * Idempotency: each of the six slots is upserted independently. The
 * seed checks whether an active row already exists for the
 * (country_code='GH', account, level) trio and skips that slot if so.
 * This is the safety net for the partial unique index
 * `subscription_plans_default_per_slot_uq` added in migration 1860 —
 * we never try to insert a second default into a slot that already has
 * one (e.g. the legacy "Bondzi Pro GH" plan, backfilled by the migration
 * to (pro, wassce)).
 *
 * Paystack plan creation runs only for recurring (Pro) rows and only
 * when PAYSTACK_SECRET_KEY_GH is in the environment. Plus rows store
 * NULL provider plan codes because one-time charges don't need a
 * Paystack `plan` object — checkout charges the amount directly.
 *
 * Re-running this seed after editing prices in the admin is safe: each
 * slot is skipped once a row exists, so admin-edited prices are not
 * clobbered.
 */

interface SeedCadence {
  cadence: 'monthly' | 'six_month' | 'annual';
  paystackInterval: 'monthly' | 'biannually' | 'annually';
  amountMinor: number;
}

interface PlusSeed {
  account: AccountType.PLUS;
  level: ExamType;
  name: string;
  description: string;
  /** Single headline price stored in `monthlyPrice`. VAT-inclusive. */
  price: number;
}

interface ProSeed {
  account: AccountType.PRO;
  level: ExamType;
  name: string;
  description: string;
  /** VAT-inclusive prices, one per cadence. */
  monthlyPrice: number;
  sixMonthPrice: number;
  annualPrice: number;
}

type PlanSeed = PlusSeed | ProSeed;

const COUNTRY = 'GH';
const CURRENCY = 'GHS';
const PROVIDER = 'paystack';
// 15% Ghana digital-services VAT-equivalent stack (VAT 12.5% + NHIL 2.5% +
// GETFund 2.5% rounds to ~15% effective for display purposes). The seed
// stamps this on every row; admins can override per plan in the editor.
const DEFAULT_VAT_RATE_PCT = 15.0;

/**
 * Launch defaults — picked to be round numbers around the existing
 * "Bondzi Pro GH" baseline (₵29 mo / ₵150 6mo / ₵240 yr). Admin will
 * fine-tune in the admin panel before launch.
 */
const PLUS_SEEDS: PlusSeed[] = [
  {
    account: AccountType.PLUS,
    level: ExamType.BECE,
    name: 'Bondzi Plus · BECE',
    description:
      'Lifetime access to BECE past papers, practice questions and AI explanations.',
    price: 150.0,
  },
  {
    account: AccountType.PLUS,
    level: ExamType.WASSCE,
    name: 'Bondzi Plus · WASSCE',
    description:
      'Lifetime access to WASSCE past papers, practice questions and AI explanations.',
    price: 250.0,
  },
  {
    account: AccountType.PLUS,
    level: ExamType.NOVDEC,
    name: 'Bondzi Plus · NOVDEC',
    description:
      'Lifetime access to NOVDEC re-sit material (WASSCE syllabus), past papers and AI explanations.',
    price: 200.0,
  },
];

const PRO_SEEDS: ProSeed[] = [
  {
    account: AccountType.PRO,
    level: ExamType.BECE,
    name: 'Bondzi Pro · BECE',
    description:
      'Bondzi Pro for BECE — everything in Plus plus AI tests, weakness analytics and curated drills.',
    monthlyPrice: 29.0,
    sixMonthPrice: 150.0,
    annualPrice: 240.0,
  },
  {
    account: AccountType.PRO,
    level: ExamType.WASSCE,
    name: 'Bondzi Pro · WASSCE',
    description:
      'Bondzi Pro for WASSCE — everything in Plus plus AI tests, weakness analytics and curated drills.',
    monthlyPrice: 39.0,
    sixMonthPrice: 200.0,
    annualPrice: 350.0,
  },
  {
    account: AccountType.PRO,
    level: ExamType.NOVDEC,
    name: 'Bondzi Pro · NOVDEC',
    description:
      'Bondzi Pro for NOVDEC re-sit candidates — AI tests, weakness analytics and curated drills focused on WASSCE re-sit syllabus.',
    monthlyPrice: 35.0,
    sixMonthPrice: 180.0,
    annualPrice: 320.0,
  },
];

export async function seedSubscriptionPlans(ds: DataSource): Promise<void> {
  const repo = ds.getRepository(SubscriptionPlanEntity);

  const all: PlanSeed[] = [...PLUS_SEEDS, ...PRO_SEEDS];
  let inserted = 0;
  let skipped = 0;

  for (const seed of all) {
    const existing = await repo.findOne({
      where: {
        countryCode: COUNTRY,
        account: seed.account,
        level: seed.level,
        isActive: true,
      },
    });
    if (existing) {
      console.log(
        `[seed] ${seed.account}×${seed.level} already exists (id=${existing.id}, name="${existing.name}") — skipping`,
      );
      skipped += 1;
      continue;
    }

    const saved = await repo.save(toEntity(repo, seed));
    inserted += 1;

    // Pro (recurring) plans need Paystack plan objects so the checkout
    // can attach a subscription. Plus plans charge once and never need a
    // Paystack plan code — skip the API calls for them.
    if (seed.account === AccountType.PRO) {
      await wireUpPaystackPlanCodes(repo, saved.id, seed);
    }
  }

  console.log(
    `[seed] subscription_plans: inserted=${inserted}, skipped=${skipped}, total_slots=${all.length}`,
  );
}

function toEntity(
  repo: ReturnType<DataSource['getRepository']>,
  seed: PlanSeed,
): SubscriptionPlanEntity {
  if (seed.account === AccountType.PLUS) {
    return repo.create({
      name: seed.name,
      description: seed.description,
      countryCode: COUNTRY,
      currency: CURRENCY,
      provider: PROVIDER,
      account: seed.account,
      level: seed.level,
      paymentKind: PaymentKind.ONE_TIME,
      vatRatePct: DEFAULT_VAT_RATE_PCT,
      // Plus stores its single price in `monthlyPrice`; the other cadence
      // columns are unused (kept at 0 for clarity).
      monthlyPrice: seed.price,
      sixMonthPrice: 0,
      annualPrice: 0,
      // Duration columns are irrelevant for lifetime grants — kept at the
      // entity defaults (30/180/365) so admin tooling doesn't break.
      isActive: true,
      isDefault: true,
      version: 1,
      parentPlanId: null,
    }) as SubscriptionPlanEntity;
  }
  return repo.create({
    name: seed.name,
    description: seed.description,
    countryCode: COUNTRY,
    currency: CURRENCY,
    provider: PROVIDER,
    account: seed.account,
    level: seed.level,
    paymentKind: PaymentKind.RECURRING,
    vatRatePct: DEFAULT_VAT_RATE_PCT,
    monthlyPrice: seed.monthlyPrice,
    sixMonthPrice: seed.sixMonthPrice,
    annualPrice: seed.annualPrice,
    isActive: true,
    isDefault: true,
    version: 1,
    parentPlanId: null,
  }) as SubscriptionPlanEntity;
}

/**
 * Create the three Paystack plan objects for a Pro row and persist their
 * codes back to the row. No-op (with a warning) when
 * `PAYSTACK_SECRET_KEY_GH` is absent — admin runs
 * `POST /admin/plans/:id/sync` once credentials are available.
 */
async function wireUpPaystackPlanCodes(
  repo: ReturnType<DataSource['getRepository']>,
  planId: string,
  seed: ProSeed,
): Promise<void> {
  const secret = process.env.PAYSTACK_SECRET_KEY_GH;
  if (!secret) {
    console.log(
      `[seed] PAYSTACK_SECRET_KEY_GH not set — "${seed.name}" stored with null provider codes. Run POST /admin/plans/${planId}/sync once credentials are available.`,
    );
    return;
  }

  const cadences: SeedCadence[] = [
    {
      cadence: 'monthly',
      paystackInterval: 'monthly',
      amountMinor: Math.round(seed.monthlyPrice * 100),
    },
    {
      cadence: 'six_month',
      paystackInterval: 'biannually',
      amountMinor: Math.round(seed.sixMonthPrice * 100),
    },
    {
      cadence: 'annual',
      paystackInterval: 'annually',
      amountMinor: Math.round(seed.annualPrice * 100),
    },
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
        name: `${seed.name} • ${c.cadence}`,
        amount: c.amountMinor,
        interval: c.paystackInterval,
        currency: CURRENCY,
      });
      codes[c.cadence] = res.data.data.plan_code;
    } catch (err) {
      console.warn(
        `[seed] failed to create Paystack ${c.cadence} plan for "${seed.name}": ${(err as Error).message}`,
      );
    }
  }

  await repo.update(planId, {
    providerPlanMonthly: codes.monthly,
    providerPlanSixMonth: codes.six_month,
    providerPlanAnnual: codes.annual,
  });

  console.log(
    `[seed] "${seed.name}" Paystack codes: monthly=${codes.monthly ?? 'null'}, six_month=${codes.six_month ?? 'null'}, annual=${codes.annual ?? 'null'}`,
  );
}
