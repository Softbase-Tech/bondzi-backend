import { DailyRenderer } from './daily.renderer';
import type { ReportDailySnapshot } from '../entities/report-daily-snapshot.entity';
import type { SnapshotMetrics } from '../collectors/collector.types';

function snap(
  date: string,
  metrics: Partial<SnapshotMetrics> = {},
): ReportDailySnapshot {
  return {
    snapshotDate: date,
    schemaVersion: 1,
    computedAt: new Date(`${date}T00:15:00Z`),
    computeMs: 1200,
    signups: null,
    dau: null,
    newPro: null,
    revenueGhs: null,
    aiSpendUsd: null,
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
        activated_cohort_date: '2026-09-09',
      },
      ...metrics,
    } as SnapshotMetrics,
  } as ReportDailySnapshot;
}

describe('DailyRenderer', () => {
  const renderer = new DailyRenderer();

  describe('the catastrophic case: every collector failed', () => {
    const empty = snap('2026-09-10', {
      _meta: {
        errors: ['growth.signups: connection terminated'],
        alerts: {},
        non_backfillable: [],
        backfilled: false,
        activated_cohort_date: '2026-09-09',
      },
    });

    it('still produces a sendable email rather than throwing', () => {
      const out = renderer.render(empty, [empty]);
      expect(out.subject).toContain('Bondzi Daily');
      expect(out.text.length).toBeGreaterThan(200);
      expect(out.html).toContain('<pre');
    });

    it('never leaks NaN, Infinity, undefined or null into the output', () => {
      const out = renderer.render(empty, [empty]);
      for (const part of [out.subject, out.text, out.html]) {
        expect(part).not.toMatch(/NaN/);
        expect(part).not.toMatch(/Infinity/);
        expect(part).not.toMatch(/undefined/);
        expect(part).not.toMatch(/\bnull\b/);
        expect(part).not.toMatch(/\[object Object\]/);
      }
    });

    it('surfaces the collector failure instead of hiding it', () => {
      const out = renderer.render(empty, [empty]);
      expect(out.text).toContain('DATA GAPS');
      expect(out.text).toContain('connection terminated');
    });

    it('reports healthy status when nothing could be evaluated', () => {
      // No alerts fired because nothing was measurable — that is not a
      // red alert, and claiming otherwise would cry wolf.
      const out = renderer.render(empty, [empty]);
      expect(out.subject).toContain('✅ healthy');
    });
  });

  describe('subject line', () => {
    it('carries the three numbers that allow phone triage', () => {
      const day = snap('2026-09-10', {
        growth: { signups: 34 },
        revenue: { new_pro_subs: 5 },
        ai: { spend_usd: 1.2 },
      });
      const out = renderer.render(day, [day]);
      expect(out.subject).toBe(
        'Bondzi Daily · 10 Sep · 34 signups · 5 Pro · $1.20 AI · ✅ healthy',
      );
    });

    it('escalates to the worst alert present', () => {
      const day = snap('2026-09-10', {
        revenue: { payment_success_rate: 0.5, charges_attempted: 40 },
        _meta: {
          errors: [],
          alerts: { payment_success_rate: 'critical', queue_depth: 'warn' },
          non_backfillable: [],
          backfilled: false,
          activated_cohort_date: '2026-09-09',
        },
      });
      const out = renderer.render(day, [day]);
      expect(out.subject).toContain('🔴 1 critical');
      expect(out.text).toContain('ATTENTION');
      // The alert names the value, not just the metric.
      expect(out.text).toContain('Payment success rate 50%');
    });
  });

  describe('context', () => {
    it('computes deltas against prior days', () => {
      const prior = [
        snap('2026-09-08', { growth: { signups: 10 } }),
        snap('2026-09-09', { growth: { signups: 10 } }),
      ];
      const today = snap('2026-09-10', { growth: { signups: 20 } });
      const out = renderer.render(today, [...prior, today]);
      expect(out.text).toMatch(/Signups\s+20\s+\+100%/);
    });

    it('labels the activation cohort with its own date, not the report date', () => {
      const day = snap('2026-09-10', {
        growth: { activated: 19, activation_rate: 0.56 },
      });
      const out = renderer.render(day, [day]);
      // Reader must never have to guess which cohort a rate refers to.
      expect(out.text).toContain('Activated (9 Sep)');
      expect(out.text).toContain('56%');
    });

    it('footnotes a backfilled day so dashes are read as structural', () => {
      const day = snap('2026-09-10', {
        _meta: {
          errors: [],
          alerts: {},
          non_backfillable: [
            'infra.queue_depth_max',
            'engagement.streaks_active',
          ],
          backfilled: true,
          activated_cohort_date: '2026-09-09',
        },
      });
      const out = renderer.render(day, [day]);
      expect(out.text).toContain('backfilled');
      expect(out.text).toContain('cannot be reconstructed');
    });

    it('states the DAU definition so the number is not misread', () => {
      const out = renderer.render(snap('2026-09-10'), []);
      expect(out.text).toContain('Active = attempted a question');
    });
  });

  describe('html', () => {
    it('escapes content rather than interpolating it raw', () => {
      const day = snap('2026-09-10', {
        _meta: {
          errors: ['<script>alert(1)</script>'],
          alerts: {},
          non_backfillable: [],
          backfilled: false,
          activated_cohort_date: '2026-09-09',
        },
      });
      const out = renderer.render(day, [day]);
      expect(out.html).not.toContain('<script>');
      expect(out.html).toContain('&lt;script&gt;');
    });

    it('carries no images, tracking pixels or external CSS', () => {
      const out = renderer.render(snap('2026-09-10'), []);
      expect(out.html).not.toMatch(/<img/i);
      expect(out.html).not.toMatch(/<link/i);
      expect(out.html).not.toMatch(/https?:\/\//);
    });
  });
});
