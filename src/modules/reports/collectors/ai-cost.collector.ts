import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BaseCollector, count, num, toRecord } from './base.collector';
import type {
  AiMetrics,
  CollectorResult,
  MetricCollector,
} from './collector.types';
import { ratio } from '../constants/thresholds';
import { dayBounds, type DateRange } from '../date-range.util';

/**
 * AI spend — the line that can quietly destroy the budget.
 *
 * **`ai_usage_log` is the only truth.** Two tempting sources are wrong:
 * the Redis day counter (`ai_cost:day:<date>`) has a 48-hour TTL, so
 * history evaporates before a weekly report could read it; and the
 * Prometheus counter `bondzi_ai_cost_usd_total` is declared but never
 * incremented, so it reads 0 forever — a source that is confidently wrong
 * rather than merely missing.
 *
 * The cost column is `cost_usd`. `estimated_cost_usd` is a different
 * thing on a different table (`ai_generation_jobs`, a pre-run estimate);
 * reaching for it here would report what a job was predicted to cost
 * rather than what it did.
 */
@Injectable()
export class AiCostCollector
  extends BaseCollector
  implements MetricCollector<AiMetrics>
{
  readonly key = 'ai';

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async collect(range: DateRange): Promise<CollectorResult<AiMetrics>> {
    return this.run<AiMetrics>(async (errors) => {
      const day = range.start;
      const { from, to } = dayBounds(day);
      const monthStart = new Date(`${day.slice(0, 7)}-01T00:00:00.000Z`);

      const totals = await this.guard(
        'ai.totals',
        errors,
        () =>
          this.ds.query<
            Array<{ spend: string; tin: string; tout: string; mtd: string }>
          >(
            `SELECT COALESCE(SUM(cost_usd)      FILTER (WHERE created_at >= $1 AND created_at < $2), 0) AS spend,
                    COALESCE(SUM(input_tokens)  FILTER (WHERE created_at >= $1 AND created_at < $2), 0) AS tin,
                    COALESCE(SUM(output_tokens) FILTER (WHERE created_at >= $1 AND created_at < $2), 0) AS tout,
                    COALESCE(SUM(cost_usd)      FILTER (WHERE created_at >= $3 AND created_at < $2), 0) AS mtd
               FROM ai_usage_log`,
            [from, to, monthStart],
          ),
        [],
      );

      const byModel = await this.guard(
        'ai.by_model',
        errors,
        () =>
          this.ds.query<Array<{ k: string | null; v: string }>>(
            `SELECT model AS k, COALESCE(SUM(cost_usd),0) AS v
               FROM ai_usage_log
              WHERE created_at >= $1 AND created_at < $2
              GROUP BY model`,
            [from, to],
          ),
        [],
      );

      const byAction = await this.guard(
        'ai.by_action',
        errors,
        () =>
          this.ds.query<Array<{ k: string | null; v: string }>>(
            `SELECT action AS k, COUNT(*) AS v
               FROM ai_usage_log
              WHERE created_at >= $1 AND created_at < $2
              GROUP BY action`,
            [from, to],
          ),
        [],
      );

      // Cost per artefact — the number that justifies the spend. Questions
      // come from the pm-test pool (generation stamps a batch id);
      // explanations from `questions.explanation_generated_at`, which
      // exists on that table only.
      const generated = await this.guard(
        'ai.generated',
        errors,
        () =>
          this.ds.query<Array<{ n: string }>>(
            `SELECT (
               (SELECT COUNT(*) FROM pm_test_questions
                 WHERE created_at >= $1 AND created_at < $2
                   AND generation_batch_id IS NOT NULL)
               +
               (SELECT COUNT(*) FROM questions
                 WHERE explanation_generated_at >= $1
                   AND explanation_generated_at < $2)
             ) AS n`,
            [from, to],
          ),
        [],
      );

      const spend = totals[0] ? num(totals[0].spend) : null;
      const mtd = totals[0] ? num(totals[0].mtd) : null;
      const modelSpend = toRecord(byModel, 'k', 'v', 'unknown');

      // Sonnet is roughly 12x Haiku per token, so a shift in *mix* is the
      // early warning — the total moves later and by then the month is
      // already committed.
      const sonnet = Object.entries(modelSpend)
        .filter(([m]) => m.toLowerCase().includes('sonnet'))
        .reduce((a, [, v]) => a + v, 0);

      // Forecast: straight-line from month-to-date. Crude on day 2, which
      // is why the alert carries a 3-day floor — but on day 8 it is what
      // tells you the cap will break on day 26, while there is still time.
      const dayOfMonth = parseInt(day.slice(8, 10), 10);
      const daysInMonth = new Date(
        Date.UTC(
          parseInt(day.slice(0, 4), 10),
          parseInt(day.slice(5, 7), 10),
          0,
        ),
      ).getUTCDate();
      const forecast =
        mtd !== null && dayOfMonth > 0
          ? (mtd / dayOfMonth) * daysInMonth
          : null;

      const generatedCount = generated[0] ? count(generated[0].n) : null;
      const proEntitled = null; // filled by the snapshot service from revenue

      return {
        spend_usd: spend,
        spend_mtd_usd: mtd,
        spend_forecast_usd: forecast === null ? null : round4(forecast),
        monthly_cap_usd: this.config.get<number>('ai.monthlyBudgetUsd') ?? null,
        by_model: modelSpend,
        by_action: toRecord(byAction, 'k', 'v', 'unknown'),
        tokens_in: totals[0] ? count(totals[0].tin) : null,
        tokens_out: totals[0] ? count(totals[0].tout) : null,
        sonnet_share: ratio(sonnet, spend),
        content_generated: generatedCount,
        cost_per_generated_item: ratio(spend, generatedCount),
        cost_per_active_pro: proEntitled,
      };
    });
  }
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
