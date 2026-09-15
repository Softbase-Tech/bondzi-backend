import { MetricsAggregatorService } from './metrics-aggregator.service';
import type { ReportDailySnapshot } from '../entities/report-daily-snapshot.entity';
import type { SnapshotMetrics } from '../collectors/collector.types';

function snap(date: string, m: Record<string, unknown>): ReportDailySnapshot {
  return {
    snapshotDate: date,
    metrics: {
      growth: {},
      engagement: {},
      revenue: {},
      ai: {},
      content: {},
      infra: {},
      _meta: {
        errors: [],
        alerts: {},
        non_backfillable: [],
        backfilled: false,
        activated_cohort_date: date,
      },
      ...m,
    } as unknown as SnapshotMetrics,
  } as ReportDailySnapshot;
}

const WEEK = { start: '2026-09-07', end: '2026-09-13' };
const DAYS = [
  '2026-09-07',
  '2026-09-08',
  '2026-09-09',
  '2026-09-10',
  '2026-09-11',
  '2026-09-12',
  '2026-09-13',
];

describe('MetricsAggregatorService', () => {
  const agg = new MetricsAggregatorService();

  describe('sum vs latest — the 30x trap', () => {
    const rows = DAYS.map((d) =>
      snap(d, {
        growth: { signups: 10 },
        revenue: { revenue_ghs: 100, mrr_ghs: 4180, active_pro_paying: 148 },
      }),
    );

    it('sums flow quantities', () => {
      const out = agg.aggregate('week', WEEK, rows, DAYS);
      expect(out.metrics.growth.signups).toBe(70);
      expect(out.metrics.revenue.revenue_ghs).toBe(700);
    });

    it('does NOT sum stock quantities — MRR is 4180, not 29,260', () => {
      const out = agg.aggregate('week', WEEK, rows, DAYS);
      // Summing here is precisely the bug that put a 12x-inflated MRR on
      // the dashboard; over a 30-day month it would be a 30x error.
      expect(out.metrics.revenue.mrr_ghs).toBe(4180);
      expect(out.metrics.revenue.active_pro_paying).toBe(148);
    });

    it('takes the most recent KNOWN stock value, not blindly the last day', () => {
      const withGap = [
        snap('2026-09-12', { revenue: { mrr_ghs: 4180 } }),
        // final day's revenue collector failed
        snap('2026-09-13', { revenue: {} }),
      ];
      const out = agg.aggregate('week', WEEK, withGap, DAYS);
      // Yesterday's MRR beats a dash.
      expect(out.metrics.revenue.mrr_ghs).toBe(4180);
    });
  });

  describe('ratios are recomputed, never averaged', () => {
    it('weights by volume — a 2-attempt day must not equal a 200-attempt day', () => {
      const rows = [
        // 1 of 2 succeeded → 50%
        snap('2026-09-12', {
          revenue: { charges_succeeded: 1, charges_attempted: 2 },
        }),
        // 198 of 200 succeeded → 99%
        snap('2026-09-13', {
          revenue: { charges_succeeded: 198, charges_attempted: 200 },
        }),
      ];
      const out = agg.aggregate('week', WEEK, rows, DAYS);
      // Correct: 199/202 = 98.5%. Averaging the daily rates would give
      // 74.5% and invent a payment incident that never happened.
      expect(out.metrics.revenue.payment_success_rate).toBeCloseTo(
        199 / 202,
        6,
      );
      expect(out.metrics.revenue.payment_success_rate).not.toBeCloseTo(
        0.745,
        2,
      );
    });

    it('returns null rather than dividing by zero', () => {
      const rows = [
        snap('2026-09-13', {
          revenue: { charges_succeeded: 0, charges_attempted: 0 },
        }),
      ];
      const out = agg.aggregate('week', WEEK, rows, DAYS);
      expect(out.metrics.revenue.payment_success_rate).toBeNull();
    });

    it('recomputes activation across the range', () => {
      const rows = [
        snap('2026-09-12', {
          growth: { activated: 5, activated_cohort_size: 20 },
        }),
        snap('2026-09-13', {
          growth: { activated: 15, activated_cohort_size: 20 },
        }),
      ];
      const out = agg.aggregate('week', WEEK, rows, DAYS);
      expect(out.metrics.growth.activation_rate).toBeCloseTo(0.5, 6);
    });
  });

  describe('distinct users', () => {
    const rows = DAYS.map((d) =>
      snap(d, { engagement: { dau: 100, wau: 400, mau: 1200 } }),
    );

    it('never sums DAU — the same student on two days is one person', () => {
      const out = agg.aggregate('week', WEEK, rows, DAYS);
      // 7 x 100 = 700 would be nonsense.
      expect(out.metrics.engagement.active_users).toBe(400);
      expect(out.metrics.engagement.dau).toBeNull();
    });

    it('picks the window matching the period', () => {
      expect(
        agg.aggregate('day', WEEK, rows, DAYS).metrics.engagement.active_users,
      ).toBe(100);
      expect(
        agg.aggregate('week', WEEK, rows, DAYS).metrics.engagement.active_users,
      ).toBe(400);
      expect(
        agg.aggregate('month', WEEK, rows, DAYS).metrics.engagement
          .active_users,
      ).toBe(1200);
    });

    it('records which field it used, so the UI can label it honestly', () => {
      expect(
        agg.aggregate('month', WEEK, rows, DAYS).meta.activeUsersField,
      ).toBe('engagement.mau');
    });
  });

  describe('series-only metrics', () => {
    it('refuses to invent a median of medians', () => {
      const rows = [
        snap('2026-09-12', { engagement: { median_accuracy: 40 } }),
        snap('2026-09-13', { engagement: { median_accuracy: 80 } }),
      ];
      const out = agg.aggregate('week', WEEK, rows, DAYS);
      expect(out.metrics.engagement.median_accuracy).toBeNull();
      // …but the daily values are still available to draw.
      expect(out.series['engagement.median_accuracy']).toEqual([40, 80]);
    });
  });

  describe('breakdowns', () => {
    it('adds count maps across days', () => {
      const rows = [
        snap('2026-09-12', {
          growth: { signups_by_exam_type: { wassce: 5, bece: 3 } },
        }),
        snap('2026-09-13', {
          growth: { signups_by_exam_type: { wassce: 7, novdec: 1 } },
        }),
      ];
      const out = agg.aggregate('week', WEEK, rows, DAYS);
      expect(out.metrics.growth.signups_by_exam_type).toEqual({
        wassce: 12,
        bece: 3,
        novdec: 1,
      });
    });

    it('recomputes sonnet share from merged spend, not from daily shares', () => {
      const rows = [
        // a big Haiku day
        snap('2026-09-12', {
          ai: { by_model: { 'claude-haiku': 40 }, spend_usd: 40 },
        }),
        // a small all-Sonnet day — 100% share, but only $0.40
        snap('2026-09-13', {
          ai: { by_model: { 'claude-sonnet-4-5': 0.4 }, spend_usd: 0.4 },
        }),
      ];
      const out = agg.aggregate('week', WEEK, rows, DAYS);
      // 0.4 / 40.4 ≈ 1%. Averaging the daily shares would report 50% and
      // trigger a cost alarm over forty cents.
      expect(out.metrics.ai.sonnet_share).toBeCloseTo(0.4 / 40.4, 6);
    });

    it('merges and re-ranks top subjects across the range', () => {
      const rows = [
        snap('2026-09-12', {
          engagement: {
            top_subjects: [
              { subject: 'Maths', attempts: 100 },
              { subject: 'Science', attempts: 90 },
            ],
          },
        }),
        snap('2026-09-13', {
          engagement: { top_subjects: [{ subject: 'Science', attempts: 200 }] },
        }),
      ];
      const out = agg.aggregate('week', WEEK, rows, DAYS);
      // Science leads on the week even though Maths led on day one.
      expect(out.metrics.engagement.top_subjects).toEqual([
        { subject: 'Science', attempts: 290 },
        { subject: 'Maths', attempts: 100 },
      ]);
    });
  });

  describe('gaps and honesty', () => {
    it('reports missing days rather than silently covering fewer', () => {
      const out = agg.aggregate('week', WEEK, [snap('2026-09-13', {})], DAYS);
      expect(out.daysCovered).toBe(1);
      expect(out.missingDays).toHaveLength(6);
    });

    it('returns null, not zero, for a metric nothing measured', () => {
      const out = agg.aggregate(
        'week',
        WEEK,
        [snap('2026-09-13', { growth: {} })],
        DAYS,
      );
      expect(out.metrics.growth?.signups).toBeUndefined();
    });

    it('handles an entirely empty range without throwing', () => {
      const out = agg.aggregate('week', WEEK, [], DAYS);
      expect(out.daysCovered).toBe(0);
      expect(out.missingDays).toEqual(DAYS);
      expect(out.alerts).toEqual({});
    });

    it('takes alerts from the latest day — a cleared warning must not colour the week', () => {
      const rows = [
        snap('2026-09-12', {
          _meta: {
            errors: [],
            alerts: { disk_used_pct: 'critical' },
            non_backfillable: [],
            backfilled: false,
            activated_cohort_date: 'x',
          },
        }),
        snap('2026-09-13', {
          _meta: {
            errors: [],
            alerts: { disk_used_pct: 'ok' },
            non_backfillable: [],
            backfilled: false,
            activated_cohort_date: 'x',
          },
        }),
      ];
      expect(agg.aggregate('week', WEEK, rows, DAYS).alerts).toEqual({
        disk_used_pct: 'ok',
      });
    });

    it('surfaces de-duplicated collector errors and backfill flags', () => {
      const rows = [
        snap('2026-09-12', {
          _meta: {
            errors: ['x failed'],
            alerts: {},
            non_backfillable: ['infra.queue_depth_max'],
            backfilled: true,
            activated_cohort_date: 'x',
          },
        }),
        snap('2026-09-13', {
          _meta: {
            errors: ['x failed'],
            alerts: {},
            non_backfillable: [],
            backfilled: false,
            activated_cohort_date: 'x',
          },
        }),
      ];
      const out = agg.aggregate('week', WEEK, rows, DAYS);
      expect(out.meta.errors).toEqual(['x failed']);
      expect(out.meta.anyBackfilled).toBe(true);
      expect(out.meta.nonBackfillable).toEqual(['infra.queue_depth_max']);
    });
  });
});
