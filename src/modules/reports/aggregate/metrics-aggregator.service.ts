import { Injectable } from '@nestjs/common';
import type { ReportDailySnapshot } from '../entities/report-daily-snapshot.entity';
import type { AlertState, Metric } from '../collectors/collector.types';
import { ACTIVE_FIELD_FOR, METRIC_RULES, type Period } from './metric-rules';
import { ratio as safeRatio } from '../constants/thresholds';
import type { DateRange } from '../date-range.util';

export interface AggregatedMetrics {
  period: Period;
  range: DateRange;
  /** Snapshots actually found. Fewer than the range means gaps. */
  daysCovered: number;
  /** Dates in range with no snapshot row. */
  missingDays: string[];
  /** Same section shape as a snapshot, aggregated per the rules. */
  metrics: Record<string, Record<string, unknown>>;
  /** Daily values for sparklines and for the series-only metrics. */
  series: Record<string, Metric[]>;
  /** Dates the series maps onto, ascending. */
  seriesDates: string[];
  /** Alert states from the most recent day in range. */
  alerts: Record<string, AlertState>;
  meta: {
    /** Collector errors across the whole range, de-duplicated. */
    errors: string[];
    /** Metrics some day in range could not reconstruct. */
    nonBackfillable: string[];
    /** True when any day in range was computed after the fact. */
    anyBackfilled: boolean;
    /** Which field the headline active-user count came from. */
    activeUsersField: string;
  };
}

/**
 * Combines daily snapshots into a day / week / month view.
 *
 * Lives in the backend rather than the admin client on purpose: the
 * weekly and monthly emails will need exactly this logic, and a second
 * implementation in React would be free to drift from it. The rules it
 * applies are in `metric-rules.ts`; this class only executes them.
 *
 * Everything is null-safe. A metric absent from every snapshot in range
 * comes back null and renders as a dash — never 0, which would read as a
 * measured result rather than a missing one.
 */
@Injectable()
export class MetricsAggregatorService {
  aggregate(
    period: Period,
    range: DateRange,
    snapshots: ReportDailySnapshot[],
    expectedDays: string[],
  ): AggregatedMetrics {
    const ordered = [...snapshots].sort((a, b) =>
      isoOf(a.snapshotDate) < isoOf(b.snapshotDate) ? -1 : 1,
    );
    const present = new Set(ordered.map((s) => isoOf(s.snapshotDate)));
    const missingDays = expectedDays.filter((d) => !present.has(d));
    const last = ordered[ordered.length - 1];

    // Every dotted path seen anywhere in range, so a metric that only
    // appeared on some days is still represented.
    const paths = new Set<string>();
    for (const s of ordered) {
      for (const [section, body] of Object.entries(s.metrics ?? {})) {
        if (section === '_meta' || !isRecord(body)) continue;
        for (const key of Object.keys(body)) paths.add(`${section}.${key}`);
      }
    }

    const series: Record<string, Metric[]> = {};
    for (const p of paths) {
      series[p] = ordered.map((s) => numberAt(s, p));
    }

    const metrics: Record<string, Record<string, unknown>> = {};
    const put = (path: string, value: unknown) => {
      const [section, key] = path.split('.');
      (metrics[section] ??= {})[key] = value;
    };

    // Ratios are computed from their PARTS, so they must be attempted
    // whenever the parts exist — not only when the daily snapshot happened
    // to carry the ratio itself. Otherwise a collector that stored the
    // numerator and denominator but not the derived rate would silently
    // drop the rate from every multi-day view.
    for (const [path, rule] of Object.entries(METRIC_RULES)) {
      if (rule.kind !== 'ratio') continue;
      const hasParts =
        series[rule.numerator ?? ''] !== undefined ||
        series[rule.denominator ?? ''] !== undefined;
      if (hasParts) paths.add(path);
    }

    for (const path of paths) {
      const rule = METRIC_RULES[path] ?? { kind: 'latest' as const };

      switch (rule.kind) {
        case 'sum':
          put(path, sum(series[path]));
          break;

        case 'latest':
          // The most recent KNOWN value, not simply the last day's — if
          // the final day's collector failed, the figure from the day
          // before is far more useful than a dash.
          put(path, lastKnown(series[path]));
          break;

        case 'ratio': {
          const num = sum(series[rule.numerator ?? '']);
          const den = sum(series[rule.denominator ?? '']);
          const r = safeRatio(num, den);
          put(path, r === null ? null : r * (rule.scale ?? 1));
          break;
        }

        case 'active':
          // Distinct users cannot be summed. The collector already stored
          // the right distinct count for each window.
          put(path, null);
          break;

        case 'series':
          // No single value is honest; the caller renders series[path].
          put(path, null);
          break;
      }
    }

    // Non-summable, non-numeric bits that still matter: merge the
    // breakdown records by adding their counts across the range.
    put(
      'growth.signups_by_exam_type',
      mergeCounts(ordered, 'growth', 'signups_by_exam_type'),
    );
    put(
      'growth.signups_by_platform',
      mergeCounts(ordered, 'growth', 'signups_by_platform'),
    );
    put(
      'growth.signups_by_campaign',
      mergeCounts(ordered, 'growth', 'signups_by_campaign'),
    );
    put('ai.by_model', mergeCounts(ordered, 'ai', 'by_model'));
    put('ai.by_action', mergeCounts(ordered, 'ai', 'by_action'));
    put(
      'engagement.top_subjects',
      mergeTop(ordered, 'engagement', 'top_subjects', 'subject', 'attempts', 5),
    );
    put(
      'content.thin_subjects',
      lastArray(ordered, 'content', 'thin_subjects'),
    );
    put('infra.queues', lastRecord(ordered, 'infra', 'queues'));
    put('infra.backup_ok', lastKnownRaw(ordered, 'infra.backup_ok'));

    // Sonnet share recomputed from the merged model spend, rather than
    // averaged from daily shares — a $40 day and a $0.40 day must not
    // count equally.
    const models = metrics.ai?.by_model as Record<string, number> | undefined;
    if (models) {
      const total = Object.values(models).reduce((a, b) => a + b, 0);
      const sonnet = Object.entries(models)
        .filter(([m]) => m.toLowerCase().includes('sonnet'))
        .reduce((a, [, v]) => a + v, 0);
      put('ai.sonnet_share', safeRatio(sonnet, total));
    }

    // Headline active users: the field whose window matches the period.
    const activeField = ACTIVE_FIELD_FOR[period];
    put('engagement.active_users', lastKnown(series[activeField] ?? []));

    // Flag rate recomputed over the whole range rather than averaged.
    put(
      'content.flag_rate_per_1k',
      (() => {
        const attempts = sum(series['engagement.questions_attempted'] ?? []);
        // Daily flag *counts* are not stored (only the open backlog and
        // the daily rate), so reconstruct the numerator from each day's
        // rate x that day's attempts.
        const flags = ordered.reduce<number | null>((acc, s) => {
          const rate = numberAt(s, 'content.flag_rate_per_1k');
          const att = numberAt(s, 'engagement.questions_attempted');
          if (rate === null || att === null) return acc;
          return (acc ?? 0) + (rate * att) / 1000;
        }, null);
        const r = safeRatio(flags, attempts);
        return r === null ? null : r * 1000;
      })(),
    );

    const errors = dedupe(
      ordered.flatMap((s) => s.metrics?._meta?.errors ?? []),
    );
    const nonBackfillable = dedupe(
      ordered.flatMap((s) => s.metrics?._meta?.non_backfillable ?? []),
    );

    return {
      period,
      range,
      daysCovered: ordered.length,
      missingDays,
      metrics,
      series,
      seriesDates: ordered.map((s) => isoOf(s.snapshotDate)),
      // Alerts describe a state, so the most recent day is the only
      // meaningful answer — a warning that cleared on Tuesday should not
      // still colour the week.
      alerts: last?.metrics?._meta?.alerts ?? {},
      meta: {
        errors,
        nonBackfillable,
        anyBackfilled: ordered.some(
          (s) => s.metrics?._meta?.backfilled === true,
        ),
        activeUsersField: activeField,
      },
    };
  }
}

// ---------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isoOf(v: string | Date): string {
  return typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10);
}

function at(s: ReportDailySnapshot, path: string): unknown {
  const [section, key] = path.split('.');
  const body = (s.metrics as unknown as Record<string, unknown>)?.[section];
  return isRecord(body) ? body[key] : undefined;
}

function numberAt(s: ReportDailySnapshot, path: string): Metric {
  const v = at(s, path);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Null when nothing in the window was known — never a misleading 0. */
function sum(values: Metric[] | undefined): Metric {
  if (!values) return null;
  const known = values.filter((v): v is number => v !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
}

function lastKnown(values: Metric[] | undefined): Metric {
  if (!values) return null;
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] !== null) return values[i];
  }
  return null;
}

function lastKnownRaw(rows: ReportDailySnapshot[], path: string): unknown {
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = at(rows[i], path);
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

function mergeCounts(
  rows: ReportDailySnapshot[],
  section: string,
  key: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const rec = at(r, `${section}.${key}`);
    if (!isRecord(rec)) continue;
    for (const [k, v] of Object.entries(rec)) {
      if (typeof v === 'number' && Number.isFinite(v))
        out[k] = (out[k] ?? 0) + v;
    }
  }
  return out;
}

function mergeTop(
  rows: ReportDailySnapshot[],
  section: string,
  key: string,
  labelField: string,
  valueField: string,
  limit: number,
): Array<Record<string, unknown>> {
  const totals = new Map<string, number>();
  for (const r of rows) {
    const arr = at(r, `${section}.${key}`);
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (!isRecord(item)) continue;
      const label = item[labelField];
      const value = item[valueField];
      if (typeof label !== 'string' || typeof value !== 'number') continue;
      totals.set(label, (totals.get(label) ?? 0) + value);
    }
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, value]) => ({ [labelField]: label, [valueField]: value }));
}

function lastArray(
  rows: ReportDailySnapshot[],
  section: string,
  key: string,
): unknown[] {
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = at(rows[i], `${section}.${key}`);
    if (Array.isArray(v)) return v;
  }
  return [];
}

function lastRecord(
  rows: ReportDailySnapshot[],
  section: string,
  key: string,
): Record<string, unknown> {
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = at(rows[i], `${section}.${key}`);
    if (isRecord(v)) return v;
  }
  return {};
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
