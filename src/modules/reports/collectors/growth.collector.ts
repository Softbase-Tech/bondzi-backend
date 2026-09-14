import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BaseCollector, count, num, toRecord } from './base.collector';
import type {
  CollectorResult,
  GrowthMetrics,
  MetricCollector,
} from './collector.types';
import { ratio } from '../constants/thresholds';
import {
  activationCohortFor,
  dayBounds,
  type DateRange,
} from '../date-range.util';

/**
 * Acquisition: who arrived, from where, and whether they did anything.
 *
 * Two rules apply to everything here:
 *
 *   - Every count over `users` filters `deleted_at IS NULL`. The table
 *     soft-deletes, and forgetting this inflates every growth number by
 *     however many accounts have been erased.
 *   - Date filters are half-open (`>= from AND < to`) against the
 *     timestamp column rather than `created_at::date = $1`. Same rows,
 *     but the index on `created_at` is usable — a cast on the left of the
 *     comparison is not sargable.
 */
@Injectable()
export class GrowthCollector
  extends BaseCollector
  implements MetricCollector<GrowthMetrics>
{
  readonly key = 'growth';

  constructor(@InjectDataSource() private readonly ds: DataSource) {
    super();
  }

  async collect(range: DateRange): Promise<CollectorResult<GrowthMetrics>> {
    return this.run<GrowthMetrics>(async (errors) => {
      const { from, to } = dayBounds(range.start);
      const cohortDate = activationCohortFor(range.start);
      const cohort = dayBounds(cohortDate);

      const signupRows = await this.guard(
        'growth.signups',
        errors,
        () =>
          this.ds.query<
            Array<{
              g_exam: number;
              g_plat: number;
              g_camp: number;
              total: string;
              exam_type: string | null;
              platform: string | null;
              campaign: string | null;
              partner: string;
              referral: string;
            }>
          >(
            // GROUPING() is load-bearing, not decoration. A row grouped by
            // signup_platform where the value is NULL (a legacy client that
            // sent no X-Platform header) is indistinguishable from the
            // grand-total row by nullness alone — both have platform NULL.
            // GROUPING() returns 1 when the column was aggregated away and
            // 0 when it is a real grouped value, which is the only reliable
            // way to tell the two apart.
            `SELECT GROUPING(u.exam_type)       AS g_exam,
                    GROUPING(u.signup_platform) AS g_plat,
                    GROUPING(u.signup_source)   AS g_camp,
                    -- DISTINCT u.id, not COUNT(*): the LEFT JOINs below
                    -- fan out a user into one row per matching attribution
                    -- or referral event, and COUNT(*) would count that user
                    -- twice. partner_attributions.user_id is unique today,
                    -- but referral_events has no such guarantee and a
                    -- future second row would silently inflate signups.
                    COUNT(DISTINCT u.id)        AS total,
                    u.exam_type                 AS exam_type,
                    u.signup_platform           AS platform,
                    u.signup_source             AS campaign,
                    COUNT(DISTINCT pa.user_id)  AS partner,
                    COUNT(DISTINCT re.referred_id) AS referral
               FROM users u
               LEFT JOIN partner_attributions pa ON pa.user_id = u.id
               LEFT JOIN referral_events      re ON re.referred_id = u.id
              WHERE u.created_at >= $1 AND u.created_at < $2
                AND u.deleted_at IS NULL
              GROUP BY GROUPING SETS ((), (u.exam_type), (u.signup_platform), (u.signup_source))`,
            [from, to],
          ),
        [],
      );

      // One grand-total row (every grouping bit set) plus one row per
      // value of each key — a single table scan instead of four queries.
      const grand = signupRows.find(
        (r) => r.g_exam === 1 && r.g_plat === 1 && r.g_camp === 1,
      );
      const signups = grand ? count(grand.total) : null;

      const byExam = toRecord(
        signupRows.filter((r) => r.g_exam === 0),
        'exam_type',
        'total',
      );
      const byPlatform = toRecord(
        signupRows.filter((r) => r.g_plat === 0),
        'platform',
        'total',
        // Legacy clients that sent no X-Platform header.
        'unknown',
      );
      const byCampaign = toRecord(
        signupRows.filter((r) => r.g_camp === 0),
        'campaign',
        'total',
        // Rows predating migration 2300000000000 carry NULL here. Reported
        // as its own bucket rather than folded into organic, which would
        // overstate organic by the entire pre-attribution history.
        'pre_attribution',
      );

      // ---- activation, on the D-1 cohort -----------------------------
      //
      // "Completed a session within 24h of signing up." Completion is
      // `status = 'completed'`, NOT `completed_at IS NOT NULL`:
      // scripts/abandon-stale-exams.ts stamps completed_at on the rows it
      // abandons, so the timestamp is set for abandoned sessions too.
      const activation = await this.guard(
        'growth.activation',
        errors,
        () =>
          this.ds.query<Array<{ cohort: string; activated: string }>>(
            `SELECT COUNT(*) AS cohort,
                    COUNT(*) FILTER (WHERE EXISTS (
                      SELECT 1 FROM exams e
                       WHERE e.user_id = u.id
                         AND e.status = 'completed'
                         AND e.completed_at IS NOT NULL
                         AND e.completed_at <= u.created_at + interval '24 hours'
                    )) AS activated
               FROM users u
              WHERE u.created_at >= $1 AND u.created_at < $2
                AND u.deleted_at IS NULL`,
            [cohort.from, cohort.to],
          ),
        [],
      );
      const cohortSize = activation[0] ? count(activation[0].cohort) : null;
      const activated = activation[0] ? count(activation[0].activated) : null;

      // ---- referrals --------------------------------------------------
      const referrals = await this.guard(
        'growth.referrals',
        errors,
        () =>
          this.ds.query<Array<{ created: string; qualified: string }>>(
            `SELECT COUNT(*) FILTER (WHERE created_at   >= $1 AND created_at   < $2) AS created,
                    COUNT(*) FILTER (WHERE qualified_at >= $1 AND qualified_at < $2) AS qualified
               FROM referral_events`,
            [from, to],
          ),
        [],
      );

      // ---- school data quality ---------------------------------------
      //
      // `users.school_name` is free text with no FK, so a distinct count is
      // dirty by nature (casing, abbreviations). The null rate is the
      // honest primary signal — it says whether the picker is being used
      // at all; the distinct count is secondary colour.
      const school = await this.guard(
        'growth.school',
        errors,
        () =>
          this.ds.query<
            Array<{ total: string; nulls: string; distinct: string }>
          >(
            `SELECT COUNT(*)                                          AS total,
                    COUNT(*) FILTER (WHERE school_name IS NULL
                                        OR btrim(school_name) = '')   AS nulls,
                    COUNT(DISTINCT lower(btrim(school_name)))
                      FILTER (WHERE school_name IS NOT NULL
                                AND btrim(school_name) <> '')         AS distinct
               FROM users
              WHERE deleted_at IS NULL`,
          ),
        [],
      );

      return {
        signups,
        signups_by_exam_type: byExam,
        signups_by_platform: byPlatform,
        signups_by_campaign: byCampaign,
        partner_attributed: grand ? count(grand.partner) : null,
        referral_attributed: grand ? count(grand.referral) : null,
        activated,
        activation_rate: ratio(activated, cohortSize),
        activated_cohort_date: cohortDate,
        activated_cohort_size: cohortSize,
        referrals_created: referrals[0] ? count(referrals[0].created) : null,
        referrals_qualified: referrals[0]
          ? count(referrals[0].qualified)
          : null,
        school_null_rate: school[0]
          ? ratio(num(school[0].nulls), num(school[0].total))
          : null,
        school_distinct: school[0] ? count(school[0].distinct) : null,
      };
    });
  }
}
