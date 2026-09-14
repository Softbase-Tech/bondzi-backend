import { Injectable } from '@nestjs/common';
import type { ReportDailySnapshot } from '../entities/report-daily-snapshot.entity';
import type {
  AlertState,
  SnapshotMetrics,
} from '../collectors/collector.types';
import { worstState } from '../constants/thresholds';
import {
  DASH,
  delta,
  esc,
  ghs,
  mean,
  n,
  padEnd,
  pct,
  shortDate,
  sparkline,
  statusToken,
  usd,
} from './format';

export interface RenderedReport {
  subject: string;
  text: string;
  html: string;
}

/** Label → threshold key, for turning alert states into readable lines. */
const ALERT_LABELS: Record<string, string> = {
  payment_success_rate: 'Payment success rate',
  activation_rate: 'Activation rate',
  ai_spend_day_usd: 'AI spend (day)',
  ai_forecast_vs_cap: 'AI month forecast vs cap',
  sonnet_share: 'Sonnet share of AI spend',
  queue_failed: 'Failed queue jobs',
  queue_depth: 'Queue depth',
  db_size_gb: 'Database size',
  redis_memory_mb: 'Redis memory',
  disk_used_pct: 'Disk used',
  flag_rate_per_1k: 'Content flag rate',
};

/**
 * The daily report: one screen, read on a phone, in about thirty seconds.
 *
 * **The subject line is the report.** It carries signups, new Pro, AI
 * spend and the status token, so the day can be triaged from a
 * notification without opening anything. Everything inside is detail for
 * the days when the subject line says something is wrong.
 *
 * The plain-text part is authored, not derived from the HTML. It is the
 * version that renders on a slow connection and in any client, and
 * building it first keeps the information hierarchy honest — anything that
 * cannot be said in fixed-width text probably should not be in a daily
 * operational email.
 */
@Injectable()
export class DailyRenderer {
  /**
   * @param day     the snapshot being reported
   * @param history preceding snapshots (oldest first) for baselines and
   *                sparklines. Seven days is the working window; fewer is
   *                fine and simply widens the `—`s.
   */
  render(
    day: ReportDailySnapshot,
    history: ReportDailySnapshot[],
  ): RenderedReport {
    const m = day.metrics;
    const date =
      typeof day.snapshotDate === 'string'
        ? day.snapshotDate.slice(0, 10)
        : new Date(day.snapshotDate).toISOString().slice(0, 10);

    const alerts = m._meta?.alerts ?? {};
    const states: AlertState[] = Object.values(alerts);
    const overall = worstState(states);
    const counts = {
      warn: states.filter((s) => s === 'warn').length,
      critical: states.filter((s) => s === 'critical').length,
    };

    const prior = history.filter((h) => h !== day);
    const baseline = (
      pick: (x: SnapshotMetrics) => number | null | undefined,
    ) => mean(prior.map((h) => pick(h.metrics) ?? null));
    const series = (pick: (x: SnapshotMetrics) => number | null | undefined) =>
      [...prior, day].map((h) => pick(h.metrics) ?? null);

    const signups = m.growth?.signups ?? null;
    const newPro = m.revenue?.new_pro_subs ?? null;
    const aiSpend = m.ai?.spend_usd ?? null;

    const subject =
      `Bondzi Daily · ${shortDate(date)} · ` +
      `${n(signups)} signups · ${n(newPro)} Pro · ${usd(aiSpend)} AI · ` +
      statusToken(overall, counts);

    // ---- attention block -------------------------------------------
    const attention = Object.entries(alerts)
      .filter(([, s]) => s !== 'ok')
      .map(([k, s]) => {
        const label = ALERT_LABELS[k] ?? k;
        return `${s === 'critical' ? '🔴' : '⚠️'} ${label}${this.alertValue(k, m)}`;
      });

    const errs = m._meta?.errors ?? [];
    const nonBackfillable = m._meta?.non_backfillable ?? [];

    // ---- plain text -------------------------------------------------
    const L: string[] = [];
    L.push(subject);
    L.push('='.repeat(Math.min(subject.length, 72)));
    L.push('');

    if (attention.length) {
      L.push('ATTENTION');
      for (const a of attention) L.push(`  ${a}`);
      L.push('');
    }
    if (errs.length) {
      L.push(`DATA GAPS (${errs.length})`);
      for (const e of errs.slice(0, 6)) L.push(`  · ${e}`);
      if (errs.length > 6) L.push(`  · …and ${errs.length - 6} more`);
      L.push('');
    }

    // Pad the value column, then ALWAYS separate the third column with an
    // explicit space. Relying on the padding alone collides whenever a
    // value is exactly the column width — "GHS 4,180.00" is 12 characters,
    // which ran straight into the note beside it.
    const row = (label: string, value: string, extra = '') =>
      L.push(
        `  ${padEnd(label, 24)}${extra ? `${padEnd(value, 12)} ${extra}` : value}`.trimEnd(),
      );

    L.push('GROWTH');
    row(
      'Signups',
      n(signups),
      delta(
        signups,
        baseline((x) => x.growth?.signups),
      ),
    );
    const byExam = m.growth?.signups_by_exam_type ?? {};
    if (Object.keys(byExam).length) {
      row(
        '  by exam',
        Object.entries(byExam)
          .map(([k, v]) => `${k} ${v}`)
          .join(' / '),
      );
    }
    const byCampaign = m.growth?.signups_by_campaign ?? {};
    if (Object.keys(byCampaign).length) {
      row(
        '  by campaign',
        Object.entries(byCampaign)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([k, v]) => `${k} ${v}`)
          .join(' / '),
      );
    }
    row(
      `Activated (${shortDate(m._meta?.activated_cohort_date ?? date)})`,
      n(m.growth?.activated ?? null),
      pct(m.growth?.activation_rate ?? null),
    );
    row('Referrals qualified', n(m.growth?.referrals_qualified ?? null));
    L.push('');

    L.push('ENGAGEMENT');
    row(
      'DAU',
      n(m.engagement?.dau ?? null),
      `${delta(
        m.engagement?.dau ?? null,
        baseline((x) => x.engagement?.dau),
      )}  ${sparkline(series((x) => x.engagement?.dau))}`,
    );
    row('DAU/MAU', pct(m.engagement?.dau_mau_ratio ?? null, 1));
    row(
      'Practice sessions',
      n(m.engagement?.practice_sessions ?? null),
      delta(
        m.engagement?.practice_sessions ?? null,
        baseline((x) => x.engagement?.practice_sessions),
      ),
    );
    row('  completed', pct(m.engagement?.sessions_completed_pct ?? null));
    row(
      'Questions attempted',
      n(m.engagement?.questions_attempted ?? null),
      delta(
        m.engagement?.questions_attempted ?? null,
        baseline((x) => x.engagement?.questions_attempted),
      ),
    );
    row(
      'Median accuracy',
      pct(toFraction(m.engagement?.median_accuracy ?? null)),
    );
    row('Mock exams', n(m.engagement?.mock_exams_taken ?? null));
    row(
      'AI explanations',
      n(m.engagement?.explanation_requests ?? null),
      `requests (${n(m.engagement?.explanations_viewed ?? null)} marked viewed)`,
    );
    const top = m.engagement?.top_subjects ?? [];
    if (top.length) {
      row(
        'Top subjects',
        top.map((t) => `${t.subject} ${t.attempts}`).join(', '),
      );
    }
    L.push('');

    L.push('MONEY');
    row(
      'Charges',
      `${n(m.revenue?.charges_attempted ?? null)} → ${n(m.revenue?.charges_succeeded ?? null)}`,
      pct(m.revenue?.payment_success_rate ?? null),
    );
    row('Revenue', ghs(m.revenue?.revenue_ghs ?? null));
    row('New Pro', n(m.revenue?.new_pro_subs ?? null));
    row(
      'Active Pro',
      `${n(m.revenue?.active_pro_paying ?? null)} paying`,
      `${n(m.revenue?.active_pro_entitled ?? null)} entitled`,
    );
    row(
      'MRR',
      ghs(m.revenue?.mrr_ghs ?? null),
      `${ghs(m.revenue?.pending_churn_ghs ?? null)} pending churn`,
    );
    row(
      'Churn',
      `${n(m.revenue?.cancellations ?? null)} cancelled`,
      `${n(m.revenue?.expiries ?? null)} lapsed`,
    );
    if ((m.revenue?.xp_redemptions ?? 0) > 0) {
      row(
        'XP redemptions',
        n(m.revenue?.xp_redemptions ?? null),
        `${n(m.revenue?.xp_credit_days ?? null)} credit days`,
      );
    }
    L.push('');

    L.push('AI');
    row(
      'Spend',
      usd(aiSpend),
      `${delta(
        aiSpend,
        baseline((x) => x.ai?.spend_usd),
      )}  ${sparkline(series((x) => x.ai?.spend_usd))}`,
    );
    row(
      'Month to date',
      usd(m.ai?.spend_mtd_usd ?? null),
      `forecast ${usd(m.ai?.spend_forecast_usd ?? null)} of ${usd(m.ai?.monthly_cap_usd ?? null)}`,
    );
    row('Sonnet share', pct(m.ai?.sonnet_share ?? null));
    row(
      'Generated',
      n(m.ai?.content_generated ?? null),
      `${usd(m.ai?.cost_per_generated_item ?? null, 4)} each`,
    );
    row('Cost per Pro', usd(m.ai?.cost_per_active_pro ?? null, 3));
    L.push('');

    L.push('CONTENT & SYSTEM');
    row(
      'Explanation coverage',
      pct(m.content?.explanation_coverage_pct ?? null),
      `${n(m.content?.questions_active ?? null)} active questions`,
    );
    row(
      'Flags',
      `${n(m.content?.flags_open ?? null)} open`,
      `${n(m.content?.flag_rate_per_1k ?? null, 1)} per 1k served`,
    );
    row(
      'Queues',
      `${n(m.infra?.queue_failed ?? null)} failed`,
      `depth ${n(m.infra?.queue_depth_max ?? null)}`,
    );
    row(
      'DB / Redis',
      `${n(m.infra?.db_size_gb ?? null, 2)} GB`,
      `${n(m.infra?.redis_memory_mb ?? null, 1)} MB`,
    );
    row(
      'Backup',
      m.infra?.backup_ok === null || m.infra?.backup_ok === undefined
        ? DASH
        : m.infra.backup_ok
          ? 'ok'
          : 'FAILED',
      m.infra?.disk_used_pct != null ? `disk ${n(m.infra.disk_used_pct)}%` : '',
    );
    L.push('');

    if (nonBackfillable.length) {
      L.push(
        `Note: this day was backfilled. Point-in-time metrics (${nonBackfillable.length}) show ${DASH} — they describe the moment a snapshot runs and cannot be reconstructed.`,
      );
      L.push('');
    }
    L.push(
      'Active = attempted a question, started a session, earned XP, or used a metered service.',
    );
    L.push(`Period: ${date} (UTC = Africa/Accra).`);

    const text = L.join('\n');

    return {
      subject,
      text,
      html: this.toHtml(subject, text, attention, overall),
    };
  }

  /** Value suffix for an alert line, so "⚠️ Disk used" says how much. */
  private alertValue(key: string, m: SnapshotMetrics): string {
    switch (key) {
      case 'payment_success_rate':
        return ` ${pct(m.revenue?.payment_success_rate ?? null)}`;
      case 'activation_rate':
        return ` ${pct(m.growth?.activation_rate ?? null)}`;
      case 'ai_spend_day_usd':
        return ` ${usd(m.ai?.spend_usd ?? null)}`;
      case 'ai_forecast_vs_cap':
        return ` ${usd(m.ai?.spend_forecast_usd ?? null)} of ${usd(m.ai?.monthly_cap_usd ?? null)}`;
      case 'sonnet_share':
        return ` ${pct(m.ai?.sonnet_share ?? null)}`;
      case 'queue_failed':
        return ` ${n(m.infra?.queue_failed ?? null)}`;
      case 'queue_depth':
        return ` ${n(m.infra?.queue_depth_max ?? null)}`;
      case 'db_size_gb':
        return ` ${n(m.infra?.db_size_gb ?? null, 2)} GB`;
      case 'redis_memory_mb':
        return ` ${n(m.infra?.redis_memory_mb ?? null, 1)} MB`;
      case 'disk_used_pct':
        return ` ${n(m.infra?.disk_used_pct ?? null)}%`;
      case 'flag_rate_per_1k':
        return ` ${n(m.content?.flag_rate_per_1k ?? null, 1)} per 1k`;
      default:
        return '';
    }
  }

  /**
   * HTML is the plain text in a `<pre>`, plus a coloured status banner.
   *
   * Deliberately minimal. Email clients strip `<style>` blocks and do not
   * support flexbox or grid reliably, so a "real" HTML layout means
   * nested tables with inline CSS — a lot of fragile markup to reproduce a
   * fixed-width report that already reads well. Monospace keeps the
   * columns aligned in every client, the sparklines render identically in
   * both parts, and there is exactly one source of truth for the content.
   *
   * No images, no tracking pixels, no external CSS: nothing to block,
   * nothing to load, no privacy question.
   */
  private toHtml(
    subject: string,
    text: string,
    attention: string[],
    state: AlertState,
  ): string {
    const bg =
      state === 'critical'
        ? '#b3261e'
        : state === 'warn'
          ? '#8a5a00'
          : '#1a1a2e';
    const banner = attention.length
      ? `<div style="margin:0 0 16px;padding:12px 14px;background:#fff4f4;border-left:4px solid ${bg};color:#1a1a2e;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif">
           ${attention.map((a) => `<div>${esc(a)}</div>`).join('')}
         </div>`
      : '';
    return `<div style="background:#ffffff;color:#1a1a2e;padding:20px;max-width:600px;margin:0 auto">
  <div style="font:600 16px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:${bg};margin:0 0 12px">${esc(subject)}</div>
  ${banner}
  <pre style="margin:0;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word;color:#1a1a2e;background:#ffffff">${esc(text)}</pre>
</div>`;
  }
}

/**
 * `percent_score` is stored 0..100; the percent formatter takes 0..1.
 * Converting here rather than in the collector keeps the stored snapshot
 * in the same units as the source column.
 */
function toFraction(v: number | null): number | null {
  return v === null ? null : v / 100;
}
