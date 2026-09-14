import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BaseCollector, count, num } from './base.collector';
import type {
  CollectorResult,
  ContentMetrics,
  MetricCollector,
} from './collector.types';
import { ratio } from '../constants/thresholds';
import { dayBounds, type DateRange } from '../date-range.util';

/**
 * Catalogue health and the hallucination proxy.
 *
 * The two question pools are counted separately and never summed:
 * `questions` defaults to `active`, while `pm_test_questions` defaults to
 * `pending_review`, so a combined "published questions" figure would mix
 * reviewed and unreviewed content under one number.
 *
 * `flag_rate` is the practical hallucination signal — flags raised per
 * 1,000 answers served. Raw flag counts track traffic; the rate tracks
 * quality, which is the thing that would actually change a decision.
 */
@Injectable()
export class ContentCollector
  extends BaseCollector
  implements MetricCollector<ContentMetrics>
{
  readonly key = 'content';

  constructor(@InjectDataSource() private readonly ds: DataSource) {
    super();
  }

  async collect(range: DateRange): Promise<CollectorResult<ContentMetrics>> {
    return this.run<ContentMetrics>(async (errors) => {
      const { from, to } = dayBounds(range.start);

      const pools = await this.guard(
        'content.pools',
        errors,
        () =>
          this.ds.query<
            Array<{ q_active: string; pm_active: string; with_expl: string }>
          >(
            `SELECT (SELECT COUNT(*) FROM questions WHERE status = 'active') AS q_active,
                    (SELECT COUNT(*) FROM pm_test_questions WHERE status = 'active') AS pm_active,
                    (SELECT COUNT(*) FROM questions
                      WHERE status = 'active' AND explanation IS NOT NULL) AS with_expl`,
          ),
        [],
      );

      const flags = await this.guard(
        'content.flags',
        errors,
        () =>
          this.ds.query<Array<{ open: string; created: string }>>(
            `SELECT COUNT(*) FILTER (WHERE is_resolved = false) AS open,
                    COUNT(*) FILTER (WHERE created_at >= $1 AND created_at < $2) AS created
               FROM question_flags`,
            [from, to],
          ),
        [],
      );

      const served = await this.guard(
        'content.served',
        errors,
        () =>
          this.ds.query<Array<{ n: string }>>(
            `SELECT COUNT(*) AS n FROM exam_answers
              WHERE answered_at >= $1 AND answered_at < $2`,
            [from, to],
          ),
        [],
      );

      // Catalogue gaps: a subject a student can pick but that has almost
      // nothing behind it is a bad first impression, and the fastest one
      // to fix.
      const thin = await this.guard(
        'content.thin_subjects',
        errors,
        () =>
          this.ds.query<Array<{ subject: string; n: string }>>(
            `SELECT s.name AS subject, COUNT(q.id) AS n
               FROM subjects s
               LEFT JOIN questions q ON q.subject_id = s.id AND q.status = 'active'
              WHERE s.is_active AND s.deleted_at IS NULL
              GROUP BY s.name
             HAVING COUNT(q.id) < 100
              ORDER BY n ASC
              LIMIT 5`,
          ),
        [],
      );

      const active = pools[0] ? count(pools[0].q_active) : null;
      const servedCount = served[0] ? count(served[0].n) : null;
      const flagsCreated = flags[0] ? count(flags[0].created) : null;

      return {
        questions_active: active,
        pm_test_active: pools[0] ? count(pools[0].pm_active) : null,
        explanation_coverage_pct: pools[0]
          ? ratio(num(pools[0].with_expl), active)
          : null,
        flags_open: flags[0] ? count(flags[0].open) : null,
        // Per 1,000 answers. Guarded like every other ratio: a day with no
        // answers served yields null, not a division by zero.
        flag_rate_per_1k:
          servedCount === null || servedCount === 0 || flagsCreated === null
            ? null
            : (flagsCreated / servedCount) * 1000,
        thin_subjects: thin.map((r) => ({
          subject: r.subject,
          questions: count(r.n),
        })),
      };
    });
  }
}
