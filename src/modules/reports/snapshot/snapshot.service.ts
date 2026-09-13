import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ReportDailySnapshot } from '../entities/report-daily-snapshot.entity';
import type {
  AlertState,
  CollectorResult,
  SnapshotMetrics,
} from '../collectors/collector.types';
import { GrowthCollector } from '../collectors/growth.collector';
import { EngagementCollector } from '../collectors/engagement.collector';
import { RevenueCollector } from '../collectors/revenue.collector';
import { AiCostCollector } from '../collectors/ai-cost.collector';
import { ContentCollector } from '../collectors/content.collector';
import { InfraCollector } from '../collectors/infra.collector';
import { evaluate, ratio } from '../constants/thresholds';
import {
  activationCohortFor,
  eachDay,
  utcDateIso,
  type DateRange,
} from '../date-range.util';

/** One collector may not hold the whole snapshot hostage. */
const COLLECTOR_TIMEOUT_MS = 30_000;

const SCHEMA_VERSION = 1;

/**
 * Computes and persists one immutable row of metrics per day.
 *
 * Collectors run concurrently and independently: a failure in one becomes
 * an entry in `_meta.errors` and a missing section in the email, never a
 * missing email. The timeout exists for the same reason — a query that
 * hangs on a lock would otherwise stall the whole snapshot past the hour
 * the report is due.
 */
@Injectable()
export class SnapshotService {
  private readonly logger = new Logger(SnapshotService.name);

  constructor(
    @InjectRepository(ReportDailySnapshot)
    private readonly repo: Repository<ReportDailySnapshot>,
    private readonly growth: GrowthCollector,
    private readonly engagement: EngagementCollector,
    private readonly revenue: RevenueCollector,
    private readonly ai: AiCostCollector,
    private readonly content: ContentCollector,
    private readonly infra: InfraCollector,
  ) {}

  /**
   * Compute and persist the snapshot for one UTC day.
   *
   * `backfilled` marks a row computed after the fact. It matters because
   * point-in-time metrics (queue depth, Redis memory, `users.streak_days`)
   * describe *now*, not the day being computed — a backfilled row records
   * them as non-backfillable so renderers dash them rather than presenting
   * today's queue depth as last Tuesday's.
   */
  async computeAndPersist(
    date: string,
    opts: { backfilled?: boolean } = {},
  ): Promise<ReportDailySnapshot> {
    const started = Date.now();
    const range: DateRange = { start: date, end: date };
    const backfilled = opts.backfilled ?? false;

    const [growth, engagement, revenue, ai, content, infra] = await Promise.all(
      [
        this.withTimeout(this.growth.key, () => this.growth.collect(range)),
        this.withTimeout(this.engagement.key, () =>
          this.engagement.collect(range),
        ),
        this.withTimeout(this.revenue.key, () => this.revenue.collect(range)),
        this.withTimeout(this.ai.key, () => this.ai.collect(range)),
        this.withTimeout(this.content.key, () => this.content.collect(range)),
        this.withTimeout(this.infra.key, () => this.infra.collect()),
      ],
    );

    const errors = [
      ...growth.errors,
      ...engagement.errors,
      ...revenue.errors,
      ...ai.errors,
      ...content.errors,
      ...infra.errors,
    ];

    // Cross-collector derivation: AI cost per entitled Pro needs the Pro
    // headcount, which lives in the revenue collector. Entitled, not
    // paying — a comped account consumes exactly as many tokens as a
    // paying one, so the paying count would flatter the figure.
    const aiData = { ...ai.data };
    aiData.cost_per_active_pro = ratio(
      aiData.spend_mtd_usd ?? null,
      revenue.data.active_pro_entitled ?? null,
    );

    const metrics: SnapshotMetrics = {
      growth: growth.data,
      engagement: engagement.data,
      revenue: revenue.data,
      ai: aiData,
      content: content.data,
      infra: infra.data,
      _meta: {
        errors,
        alerts: this.evaluateAlerts({
          growth: growth.data,
          revenue: revenue.data,
          ai: aiData,
          content: content.data,
          infra: infra.data,
        }),
        non_backfillable: backfilled ? [...InfraCollector.POINT_IN_TIME] : [],
        backfilled,
        activated_cohort_date:
          growth.data.activated_cohort_date ?? activationCohortFor(date),
      },
    };

    const computeMs = Date.now() - started;

    // Upsert: a re-run for the same day replaces it. Snapshots are
    // immutable by convention, not by constraint — a deliberate
    // recomputation after fixing a collector bug is a legitimate act, and
    // making it impossible would mean living with known-bad history.
    await this.repo
      .createQueryBuilder()
      .insert()
      .into(ReportDailySnapshot)
      .values({
        snapshotDate: date,
        schemaVersion: SCHEMA_VERSION,
        metrics,
        computedAt: new Date(),
        computeMs,
      })
      .orUpdate(
        ['metrics', 'computed_at', 'compute_ms', 'schema_version'],
        ['snapshot_date'],
      )
      .execute();

    this.logger.log(
      `[reports] snapshot ${date} computed in ${computeMs}ms` +
        (errors.length ? ` with ${errors.length} collector error(s)` : ''),
    );
    return (await this.load({ start: date, end: date }))[0];
  }

  /** Load persisted snapshots for a range, ascending. */
  async load(range: DateRange): Promise<ReportDailySnapshot[]> {
    return this.repo
      .createQueryBuilder('s')
      .where('s.snapshot_date >= :start AND s.snapshot_date <= :end', range)
      .orderBy('s.snapshot_date', 'ASC')
      .getMany();
  }

  /**
   * Compute any snapshots missing from a range.
   *
   * Called before rendering so a report covers a hole rather than
   * reporting one. Anything derivable from durable tables reconstructs
   * exactly; point-in-time metrics cannot and are flagged.
   */
  async ensureRange(range: DateRange): Promise<string[]> {
    const have = new Set(
      (await this.load(range)).map((s) => toIso(s.snapshotDate)),
    );
    const missing = eachDay(range).filter((d) => !have.has(d));
    for (const d of missing) {
      this.logger.warn(`[reports] backfilling missing snapshot ${d}`);
      await this.computeAndPersist(d, { backfilled: true });
    }
    return missing;
  }

  private evaluateAlerts(m: {
    growth: SnapshotMetrics['growth'];
    revenue: SnapshotMetrics['revenue'];
    ai: SnapshotMetrics['ai'];
    content: SnapshotMetrics['content'];
    infra: SnapshotMetrics['infra'];
  }): Record<string, AlertState> {
    const forecastVsCap =
      m.ai.spend_forecast_usd != null && m.ai.monthly_cap_usd
        ? m.ai.spend_forecast_usd / m.ai.monthly_cap_usd
        : null;
    const dayOfMonth = new Date().getUTCDate();

    return {
      payment_success_rate: evaluate(
        'payment_success_rate',
        m.revenue.payment_success_rate ?? null,
        m.revenue.charges_attempted ?? 0,
      ),
      activation_rate: evaluate(
        'activation_rate',
        m.growth.activation_rate ?? null,
        m.growth.activated_cohort_size ?? 0,
      ),
      ai_spend_day_usd: evaluate('ai_spend_day_usd', m.ai.spend_usd ?? null),
      ai_forecast_vs_cap: evaluate(
        'ai_forecast_vs_cap',
        forecastVsCap,
        dayOfMonth,
      ),
      sonnet_share: evaluate('sonnet_share', m.ai.sonnet_share ?? null),
      queue_failed: evaluate('queue_failed', m.infra.queue_failed ?? null),
      queue_depth: evaluate('queue_depth', m.infra.queue_depth_max ?? null),
      db_size_gb: evaluate('db_size_gb', m.infra.db_size_gb ?? null),
      redis_memory_mb: evaluate(
        'redis_memory_mb',
        m.infra.redis_memory_mb ?? null,
      ),
      disk_used_pct: evaluate('disk_used_pct', m.infra.disk_used_pct ?? null),
      flag_rate_per_1k: evaluate(
        'flag_rate_per_1k',
        m.content.flag_rate_per_1k ?? null,
        // Floor is expressed in answers served, which is the denominator
        // the rate was computed from.
        m.content.flag_rate_per_1k != null && m.content.flags_open != null
          ? Math.round(
              ((m.content.flags_open ?? 0) /
                (m.content.flag_rate_per_1k || 1)) *
                1000,
            )
          : 0,
      ),
    };
  }

  /**
   * `Promise.race` against a timer. The collector keeps running after a
   * timeout — there is no way to cancel a query mid-flight from here — but
   * the snapshot stops waiting, which is what matters for hitting the
   * report's send window.
   */
  private async withTimeout<T extends object>(
    key: string,
    fn: () => Promise<CollectorResult<T>>,
  ): Promise<CollectorResult<T>> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<CollectorResult<T>>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            data: {},
            errors: [`${key}: timed out after ${COLLECTOR_TIMEOUT_MS}ms`],
            durationMs: COLLECTOR_TIMEOUT_MS,
          }),
        COLLECTOR_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([fn(), timeout]);
    } catch (err) {
      // BaseCollector.run() already swallows query failures, so reaching
      // here means the collector itself threw — a bug in the collector
      // rather than in the data. Converting it to an error result keeps
      // the contract true from the caller's side: one broken collector
      // costs its own section, never the whole snapshot.
      return {
        data: {},
        errors: [`${key}: ${(err as Error).message}`],
        durationMs: 0,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** `date` columns come back as a Date from some drivers, a string from others. */
function toIso(v: string | Date): string {
  return typeof v === 'string' ? v.slice(0, 10) : utcDateIso(v);
}
