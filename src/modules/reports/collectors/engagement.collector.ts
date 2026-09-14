import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BaseCollector, count, num } from './base.collector';
import type {
  CollectorResult,
  EngagementMetrics,
  MetricCollector,
} from './collector.types';
import { ratio } from '../constants/thresholds';
import { dayBounds, shiftIso, type DateRange } from '../date-range.util';

/**
 * What students actually did.
 *
 * **The DAU definition is the important decision here.** The backend keeps
 * no per-request activity log, so "made an authenticated request" has no
 * data source at all. The canonical definition used by every report is the
 * union of the four durable per-day signals below:
 *
 *     attempted a question, started a session, earned XP,
 *     or consumed a metered service
 *
 * `user_service_usage` is written by the entitlement guard on every
 * metered call and is never pruned, so it is the widest net of the four.
 * The known undercount is a student who only browses free content: no
 * attempt, no XP event, no metered call, and therefore invisible. That is
 * acceptable — this counts *learning* actions, which is what a habit
 * metric should measure, and the email footer states the definition once
 * so the number is never mistaken for request-level traffic.
 */
@Injectable()
export class EngagementCollector
  extends BaseCollector
  implements MetricCollector<EngagementMetrics>
{
  readonly key = 'engagement';

  constructor(@InjectDataSource() private readonly ds: DataSource) {
    super();
  }

  /**
   * Distinct active users in a half-open window.
   *
   * `user_service_usage.day` is a DATE (Accra wall-clock, which equals UTC
   * for Ghana) while the other three are timestamptz — hence the two
   * parameter pairs. They are numerically identical today; the comment
   * exists so a future region change surfaces here rather than silently
   * skewing a day.
   */
  private async activeUsers(
    fromIso: string,
    toIsoExclusive: string,
  ): Promise<number | null> {
    const { from } = dayBounds(fromIso);
    const to = dayBounds(shiftIso(toIsoExclusive, -1)).to;
    const rows = await this.ds.query<Array<{ n: string }>>(
      `SELECT COUNT(DISTINCT t.user_id) AS n
         FROM (
           SELECT user_id   FROM exams           WHERE started_at  >= $1 AND started_at  < $2
           UNION
           SELECT e.user_id FROM exam_answers a
             JOIN exams e ON e.id = a.exam_id
            WHERE a.answered_at >= $1 AND a.answered_at < $2
           UNION
           SELECT user_id   FROM xp_transactions WHERE created_at  >= $1 AND created_at  < $2
           UNION
           SELECT user_id   FROM user_service_usage WHERE day >= $3 AND day <= $4
         ) t
         JOIN users u ON u.id = t.user_id AND u.deleted_at IS NULL`,
      [from, to, fromIso, shiftIso(toIsoExclusive, -1)],
    );
    return rows[0] ? count(rows[0].n) : null;
  }

  async collect(range: DateRange): Promise<CollectorResult<EngagementMetrics>> {
    return this.run<EngagementMetrics>(async (errors) => {
      const day = range.start;
      const { from, to } = dayBounds(day);
      const next = shiftIso(day, 1);

      const dau = await this.guard(
        'engagement.dau',
        errors,
        () => this.activeUsers(day, next),
        null,
      );
      const wau = await this.guard(
        'engagement.wau',
        errors,
        () => this.activeUsers(shiftIso(day, -6), next),
        null,
      );
      const mau = await this.guard(
        'engagement.mau',
        errors,
        () => this.activeUsers(shiftIso(day, -27), next),
        null,
      );

      // Sessions. Completion is `status = 'completed'` — NOT
      // `completed_at IS NOT NULL`, which is also true for sessions the
      // stale-exam script abandoned (it stamps completed_at on them) and
      // would overstate the completion rate.
      const sessions = await this.guard(
        'engagement.sessions',
        errors,
        () =>
          this.ds.query<
            Array<{
              started: string;
              completed: string;
              mock: string;
              quiz: string;
              median: string | null;
            }>
          >(
            `SELECT COUNT(*)                                             AS started,
                    COUNT(*) FILTER (WHERE status = 'completed')         AS completed,
                    COUNT(*) FILTER (WHERE status = 'completed'
                                       AND mode = 'mock_exam')           AS mock,
                    COUNT(*) FILTER (WHERE mode = 'pm_test')             AS quiz,
                    percentile_cont(0.5) WITHIN GROUP (
                      ORDER BY percent_score
                    ) FILTER (WHERE status = 'completed'
                                AND percent_score IS NOT NULL)           AS median
               FROM exams
              WHERE started_at >= $1 AND started_at < $2`,
            [from, to],
          ),
        [],
      );
      const started = sessions[0] ? count(sessions[0].started) : null;
      const completed = sessions[0] ? count(sessions[0].completed) : null;

      // Attempts + explanation views. `is_correct` is nullable (typed,
      // ungraded answers) but attempts do not filter on it — a count of
      // attempts is a count of attempts.
      const answers = await this.guard(
        'engagement.answers',
        errors,
        () =>
          this.ds.query<Array<{ attempts: string; viewed: string }>>(
            `SELECT COUNT(*)                                          AS attempts,
                    COUNT(*) FILTER (WHERE explanation_viewed)        AS viewed
               FROM exam_answers
              WHERE answered_at >= $1 AND answered_at < $2`,
            [from, to],
          ),
        [],
      );

      // Interim proxy for explanation consumption. The real
      // `explanation_viewed` write landed 2026-08-27 and only fires when
      // the client passes examId, so coverage is bounded by client
      // rollout and everything before that date reads false. Reporting
      // both, labelled differently, is what stops a low view count being
      // misread as disengagement when it is really missing instrumentation.
      const requests = await this.guard(
        'engagement.explanation_requests',
        errors,
        () =>
          this.ds.query<Array<{ n: string }>>(
            `SELECT COUNT(*) AS n FROM ai_usage_log
              WHERE created_at >= $1 AND created_at < $2
                AND action = 'explanation'`,
            [from, to],
          ),
        [],
      );

      // Point-in-time: `users.streak_days` is overwritten in place, so a
      // backfilled snapshot cannot reconstruct this for a past day. The
      // snapshot service flags it non-backfillable when backfilling.
      const streaks = await this.guard(
        'engagement.streaks',
        errors,
        () =>
          this.ds.query<Array<{ n: string }>>(
            `SELECT COUNT(*) AS n FROM users
              WHERE deleted_at IS NULL AND streak_days >= 3`,
          ),
        [],
      );

      // Subject breakdown needs the two-branch join: exam_answers has no
      // subject_id, and its question_id has no FK — it points at either
      // `questions` or `pm_test_questions` depending on question_pool.
      const subjects = await this.guard(
        'engagement.subjects',
        errors,
        () =>
          this.ds.query<Array<{ subject: string; attempts: string }>>(
            `SELECT s.name AS subject, COUNT(*) AS attempts
               FROM exam_answers a
               JOIN LATERAL (
                 SELECT q.subject_id FROM questions q
                  WHERE a.question_pool = 'past_paper' AND q.id = a.question_id
                 UNION ALL
                 SELECT p.subject_id FROM pm_test_questions p
                  WHERE a.question_pool = 'pm_test' AND p.id = a.question_id
               ) src ON TRUE
               JOIN subjects s ON s.id = src.subject_id
              WHERE a.answered_at >= $1 AND a.answered_at < $2
              GROUP BY s.name
              ORDER BY attempts DESC
              LIMIT 5`,
            [from, to],
          ),
        [],
      );

      return {
        dau,
        wau,
        mau,
        dau_mau_ratio: ratio(dau, mau),
        practice_sessions: started,
        sessions_completed: completed,
        sessions_completed_pct: ratio(completed, started),
        questions_attempted: answers[0] ? count(answers[0].attempts) : null,
        median_accuracy: sessions[0] ? num(sessions[0].median) : null,
        mock_exams_taken: sessions[0] ? count(sessions[0].mock) : null,
        quiz_sessions: sessions[0] ? count(sessions[0].quiz) : null,
        explanations_viewed: answers[0] ? count(answers[0].viewed) : null,
        explanation_requests: requests[0] ? count(requests[0].n) : null,
        streaks_active: streaks[0] ? count(streaks[0].n) : null,
        top_subjects: subjects.map((r) => ({
          subject: r.subject,
          attempts: count(r.attempts),
        })),
      };
    });
  }
}
