import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SubscriptionMetricsService } from './subscription-metrics.service';
import { Subscription } from '../entities/subscription.entity';

/**
 * The value of this service is entirely in its WHERE clause, and a wrong
 * WHERE clause produces a plausible number rather than an error — which is
 * exactly how the previous `SUM(amount_ghs) WHERE status='active'` shipped
 * to the dashboard and stayed there.
 *
 * So these tests assert the predicate, not a row count: every exclusion
 * that makes the figure correct (one-time plans, admin comps, XP credits,
 * lapsed rows) has to be visibly present in the SQL the builder emits.
 */
interface Captured {
  wheres: string[];
  selects: string[];
  params: Record<string, unknown>;
}

function makeRepo(raw: Record<string, string>) {
  const captured: Captured = { wheres: [], selects: [], params: {} };
  const qb: Record<string, unknown> = {};
  const chain =
    (bucket?: string[]) =>
    (...args: unknown[]) => {
      if (bucket) bucket.push(String(args[0]));
      if (args[1] && typeof args[1] === 'object') {
        Object.assign(captured.params, args[1]);
      }
      return qb;
    };
  qb.innerJoin = chain();
  qb.where = chain(captured.wheres);
  qb.andWhere = chain(captured.wheres);
  qb.select = chain(captured.selects);
  qb.addSelect = chain(captured.selects);
  qb.getRawOne = jest.fn().mockResolvedValue(raw);
  return {
    repo: { createQueryBuilder: jest.fn(() => qb) },
    captured,
  };
}

async function build(raw: Record<string, string>) {
  const { repo, captured } = makeRepo(raw);
  const moduleRef = await Test.createTestingModule({
    providers: [
      SubscriptionMetricsService,
      { provide: getRepositoryToken(Subscription), useValue: repo },
    ],
  }).compile();
  return { service: moduleRef.get(SubscriptionMetricsService), captured };
}

describe('SubscriptionMetricsService.mrr', () => {
  const raw = {
    mrr: '450.00',
    pending_churn: '30.00',
    paying_subs: '15',
    cancelled_subs: '1',
  };

  it('normalises through plan.monthly_price, never subscriptions.amount_ghs', async () => {
    const { service, captured } = await build(raw);
    await service.mrr();
    const sql = captured.selects.join(' | ');
    expect(sql).toContain('p.monthly_price');
    // The original bug. An annual sub's charged amount is 12x its MRR.
    expect(sql).not.toContain('amount_ghs');
  });

  it('counts only recurring plans — a lifetime Plus is not monthly revenue', async () => {
    const { service, captured } = await build(raw);
    await service.mrr();
    expect(captured.wheres.join(' | ')).toContain(
      "p.payment_kind = 'recurring'",
    );
  });

  it('excludes admin comps and XP-credited grants — neither has cash behind it', async () => {
    const { service, captured } = await build(raw);
    await service.mrr();
    const where = captured.wheres.join(' | ');
    expect(where).toContain("s.provider IS DISTINCT FROM 'manual'");
    expect(where).toContain("s.status <> 'xp_credited'");
  });

  it('excludes lapsed rows and mirrors the cancellation-grace rule', async () => {
    const { service, captured } = await build(raw);
    await service.mrr();
    const where = captured.wheres.join(' ');
    // Same shape as SubscriptionsService.entitlementFor(): a cancelled row
    // keeps access until its paid term ends.
    expect(where).toContain("s.status = 'cancelled' AND s.expires_at > :asOf");
    expect(where).toContain('s.expires_at IS NULL OR s.expires_at > :asOf');
  });

  it('keeps cancelled-but-entitled OUT of mrr and reports it as pending churn', async () => {
    const { service } = await build(raw);
    const out = await service.mrr();
    expect(out.mrrGhs).toBe(450);
    // Not folded into mrrGhs: it bills nothing next cycle.
    expect(out.pendingChurnGhs).toBe(30);
    expect(out.payingRecurringSubs).toBe(15);
    expect(out.cancelledStillEntitled).toBe(1);
  });

  it('returns zeros rather than NaN on an empty table', async () => {
    const { service } = await build({
      mrr: '0',
      pending_churn: '0',
      paying_subs: '0',
      cancelled_subs: '0',
    });
    const out = await service.mrr();
    expect(out).toEqual({
      mrrGhs: 0,
      pendingChurnGhs: 0,
      payingRecurringSubs: 0,
      cancelledStillEntitled: 0,
    });
  });

  it('rounds to whole pesewas so float drift cannot leak into a currency', async () => {
    const { service } = await build({
      mrr: '0.1',
      pending_churn: '0.2',
      paying_subs: '2',
      cancelled_subs: '0',
    });
    const out = await service.mrr();
    expect(out.mrrGhs).toBe(0.1);
    expect(out.pendingChurnGhs).toBe(0.2);
  });

  it('accepts an asOf so a backfilled snapshot can ask about a past day', async () => {
    const asOf = new Date('2026-08-01T00:00:00.000Z');
    const { service, captured } = await build(raw);
    await service.mrr(asOf);
    expect(captured.params.asOf).toBe(asOf);
  });
});

describe('SubscriptionMetricsService.entitledPro', () => {
  it('reports paying and total separately — comps cost AI but earn nothing', async () => {
    const { service, captured } = await build({ total: '20', paying: '15' });
    const out = await service.entitledPro();
    expect(out).toEqual({ paying: 15, totalEntitled: 20 });
    // `total` must NOT carry the paying exclusions.
    const paying = captured.selects.find((s) => s.includes('FILTER'));
    expect(paying).toContain("s.provider IS DISTINCT FROM 'manual'");
    expect(paying).toContain("s.status <> 'xp_credited'");
  });
});
