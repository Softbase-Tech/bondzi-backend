import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SnapshotService } from './snapshot.service';
import { ReportDailySnapshot } from '../entities/report-daily-snapshot.entity';
import { GrowthCollector } from '../collectors/growth.collector';
import { EngagementCollector } from '../collectors/engagement.collector';
import { RevenueCollector } from '../collectors/revenue.collector';
import { AiCostCollector } from '../collectors/ai-cost.collector';
import { ContentCollector } from '../collectors/content.collector';
import { InfraCollector } from '../collectors/infra.collector';
import type { SnapshotMetrics } from '../collectors/collector.types';

/**
 * The orchestration exists to keep one broken data source from costing
 * the whole report. These tests pin that: a collector that fails, or
 * hangs, must leave a sendable snapshot behind with the reason recorded.
 */
function stubCollector(key: string, data: object = {}, errors: string[] = []) {
  return {
    key,
    collect: jest.fn().mockResolvedValue({ data, errors, durationMs: 1 }),
  };
}

describe('SnapshotService', () => {
  let saved: { values?: Record<string, unknown> };
  let repo: Record<string, jest.Mock>;

  function makeRepo() {
    saved = {};
    const qb: Record<string, unknown> = {};
    const chain = () => () => qb;
    qb.insert = chain();
    qb.into = chain();
    qb.values = jest.fn((v: Record<string, unknown>) => {
      saved.values = v;
      return qb;
    });
    qb.orUpdate = chain();
    qb.execute = jest.fn().mockResolvedValue({});
    qb.where = chain();
    qb.orderBy = chain();
    qb.getMany = jest.fn().mockResolvedValue([]);
    return { createQueryBuilder: jest.fn(() => qb) };
  }

  async function build(overrides: Record<string, unknown> = {}) {
    repo = makeRepo() as unknown as Record<string, jest.Mock>;
    const providers = [
      SnapshotService,
      { provide: getRepositoryToken(ReportDailySnapshot), useValue: repo },
      {
        provide: GrowthCollector,
        useValue: overrides.growth ?? stubCollector('growth', { signups: 34 }),
      },
      {
        provide: EngagementCollector,
        useValue:
          overrides.engagement ?? stubCollector('engagement', { dau: 287 }),
      },
      {
        provide: RevenueCollector,
        useValue:
          overrides.revenue ??
          stubCollector('revenue', {
            active_pro_entitled: 100,
            active_pro_paying: 90,
          }),
      },
      {
        provide: AiCostCollector,
        useValue: overrides.ai ?? stubCollector('ai', { spend_mtd_usd: 20 }),
      },
      {
        provide: ContentCollector,
        useValue: overrides.content ?? stubCollector('content', {}),
      },
      {
        provide: InfraCollector,
        useValue: overrides.infra ?? stubCollector('infra', {}),
      },
    ];
    const m = await Test.createTestingModule({ providers }).compile();
    return m.get(SnapshotService);
  }

  const persisted = () => saved.values?.metrics as SnapshotMetrics;

  it('persists a row containing every section', async () => {
    const svc = await build();
    await svc.computeAndPersist('2026-09-10');
    const m = persisted();
    expect(Object.keys(m).sort()).toEqual([
      '_meta',
      'ai',
      'content',
      'engagement',
      'growth',
      'infra',
      'revenue',
    ]);
    expect(m.growth.signups).toBe(34);
  });

  it('records a failing collector as an error instead of aborting', async () => {
    const svc = await build({
      revenue: stubCollector('revenue', {}, [
        'revenue.attempts: deadlock detected',
      ]),
    });
    await svc.computeAndPersist('2026-09-10');
    // The snapshot still exists, and says why revenue is thin.
    expect(saved.values).toBeDefined();
    expect(persisted()._meta.errors).toContain(
      'revenue.attempts: deadlock detected',
    );
    expect(persisted().growth.signups).toBe(34);
  });

  it('survives a collector that throws outright', async () => {
    const svc = await build({
      content: {
        key: 'content',
        collect: jest.fn().mockRejectedValue(new Error('boom')),
      },
    });
    await expect(svc.computeAndPersist('2026-09-10')).resolves.not.toThrow();
  });

  it('derives cost-per-Pro across collectors using ENTITLED, not paying', async () => {
    const svc = await build();
    await svc.computeAndPersist('2026-09-10');
    // 20 MTD / 100 entitled. Using the 90 paying would flatter the figure,
    // and a comped account burns exactly as many tokens as a paying one.
    expect(persisted().ai.cost_per_active_pro).toBeCloseTo(0.2, 6);
  });

  it('yields null cost-per-Pro rather than dividing by zero', async () => {
    const svc = await build({
      revenue: stubCollector('revenue', { active_pro_entitled: 0 }),
    });
    await svc.computeAndPersist('2026-09-10');
    expect(persisted().ai.cost_per_active_pro).toBeNull();
  });

  it('flags point-in-time metrics when backfilling, and not otherwise', async () => {
    const svc = await build();

    await svc.computeAndPersist('2026-09-10');
    expect(persisted()._meta.backfilled).toBe(false);
    expect(persisted()._meta.non_backfillable).toEqual([]);

    await svc.computeAndPersist('2026-09-10', { backfilled: true });
    const meta = persisted()._meta;
    expect(meta.backfilled).toBe(true);
    // Queue depth and streak counts describe the moment the snapshot ran;
    // presenting today's values as a past day's would be fabrication.
    expect(meta.non_backfillable).toEqual(InfraCollector.POINT_IN_TIME);
    expect(meta.non_backfillable).toContain('engagement.streaks_active');
  });

  it('records the activation cohort date in meta', async () => {
    const svc = await build();
    await svc.computeAndPersist('2026-09-10');
    expect(persisted()._meta.activated_cohort_date).toBe('2026-09-09');
  });

  it('does not wait forever on a hung collector', async () => {
    jest.useFakeTimers();
    try {
      const svc = await build({
        infra: {
          key: 'infra',
          collect: jest.fn(() => new Promise(() => {})), // never resolves
        },
      });
      const p = svc.computeAndPersist('2026-09-10');
      await jest.advanceTimersByTimeAsync(31_000);
      await p;
      expect(
        persisted()._meta.errors.some((e) => e.includes('timed out')),
      ).toBe(true);
      // …and the rest of the report survived the timeout.
      expect(persisted().growth.signups).toBe(34);
    } finally {
      jest.useRealTimers();
    }
  });
});
