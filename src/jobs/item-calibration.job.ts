import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { AdminAlertService } from '../modules/mail/admin-alert.service';

/**
 * Live item calibration from real student answers (premium plan §7.6).
 * Pure SQL — zero AI cost — so it runs on by default.
 *
 * Weekly, for every question with enough attempts:
 *   • p-value  = share of correct answers (classical difficulty)
 *   • r        = point-biserial discrimination — correlation between
 *                getting THIS item right and the student's overall
 *                exam score. Negative r with real volume is the
 *                classic bad-answer-key signature: strong students
 *                "miss" it because the key is wrong.
 *
 * Writes `questions.irt_difficulty` (logit of p, clamped ±3, higher =
 * harder) for the past-paper pool, and pulls suspect items from
 * circulation: n ≥ 50 AND (p < 0.15 OR r < 0) → status =
 * pending_review (both pools) + an email listing them. This is the
 * ground-truth feedback loop no prompt work substitutes for —
 * students grading our questions at scale.
 *
 * Disable with AI_ITEM_CALIBRATION_ENABLED=false.
 */
const LOCK_KEY = 17_010;
const MIN_N_STATS = 30;
const MIN_N_FLAG = 50;
const P_FLOOR = 0.15;

interface ItemStat {
  id: string;
  pool: 'past_paper' | 'pm_test';
  n: number;
  p: number;
  r: number | null;
}

@Injectable()
export class ItemCalibrationJob {
  private readonly logger = new Logger(ItemCalibrationJob.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly adminAlerts: AdminAlertService,
  ) {}

  @Cron('30 2 * * 0', { timeZone: 'UTC' })
  async run(): Promise<void> {
    if (process.env.WORKER_MODE !== 'true') return;
    if (process.env.AI_ITEM_CALIBRATION_ENABLED === 'false') return;

    await this.dataSource.transaction(async (em) => {
      const rows: Array<{ locked: boolean }> = await em.query(
        'SELECT pg_try_advisory_xact_lock(1, $1) AS locked',
        [LOCK_KEY],
      );
      if (!rows[0]?.locked) return;
      await this.calibrate();
    });
  }

  /** Public for the manual admin trigger / tests. */
  async calibrate(): Promise<{ updated: number; flagged: string[] }> {
    const stats = await this.collectStats();
    let updated = 0;
    const flagged: string[] = [];

    for (const s of stats) {
      // Classical → logit difficulty for the past-paper pool (the
      // pm_test table has no irt column yet). p clamped away from
      // 0/1 so the logit stays finite.
      if (s.pool === 'past_paper') {
        // b = ln((1-p)/p): p=0.5 → 0; harder items positive. Clamped
        // ±3 and p clamped away from 0/1 so the logit stays finite.
        const p = Math.min(0.99, Math.max(0.01, s.p));
        const difficulty = Math.max(-3, Math.min(3, Math.log((1 - p) / p)));
        await this.dataSource.query(
          `UPDATE questions SET irt_difficulty = $1 WHERE id = $2`,
          [Number(difficulty.toFixed(3)), s.id],
        );
        updated += 1;
      }

      // Bad-item flagging: enough volume AND (nearly nobody gets it
      // right, or strong students do WORSE on it than weak ones).
      if (s.n >= MIN_N_FLAG && (s.p < P_FLOOR || (s.r !== null && s.r < 0))) {
        const table =
          s.pool === 'past_paper' ? 'questions' : 'pm_test_questions';
        // pg's UPDATE … RETURNING through dataSource.query comes back
        // as [returnedRows, affectedCount].
        const res: [Array<{ id: string }>, number] =
          await this.dataSource.query(
            `UPDATE "${table}" SET status = 'pending_review'
            WHERE id = $1 AND status = 'active'
            RETURNING id`,
            [s.id],
          );
        if (res[0]?.length > 0) {
          flagged.push(
            `${s.pool}:${s.id} (n=${s.n}, p=${s.p.toFixed(2)}, r=${s.r?.toFixed(2) ?? '—'})`,
          );
        }
      }
    }

    this.logger.log(
      `[item-calibration] stats=${stats.length} irtUpdated=${updated} flagged=${flagged.length}`,
    );
    if (flagged.length > 0) {
      try {
        await this.adminAlerts.send(
          `Item calibration: ${flagged.length} question(s) pulled to review`,
          `Live answer statistics flagged these items (low p-value = almost nobody gets it right; negative discrimination = strong students miss it, the classic wrong-key signature). They were moved to pending_review:\n\n${flagged.join('\n')}`,
        );
      } catch (err) {
        this.logger.warn(
          `[item-calibration] alert email failed: ${(err as Error).message}`,
        );
      }
    }
    return { updated, flagged };
  }

  private async collectStats(): Promise<ItemStat[]> {
    const rows: Array<{
      id: string;
      pool: 'past_paper' | 'pm_test';
      n: number;
      p: number;
      r: number | null;
    }> = await this.dataSource.query(
      `SELECT a.question_id AS id,
              a.question_pool AS pool,
              count(*)::int AS n,
              avg(CASE WHEN a.is_correct THEN 1.0 ELSE 0.0 END)::float AS p,
              corr(CASE WHEN a.is_correct THEN 1.0 ELSE 0.0 END,
                   e.percent_score::float) AS r
         FROM exam_answers a
         JOIN exams e ON e.id = a.exam_id
        WHERE a.is_correct IS NOT NULL
          AND e.percent_score IS NOT NULL
        GROUP BY a.question_id, a.question_pool
       HAVING count(*) >= $1`,
      [MIN_N_STATS],
    );
    return rows.map((r) => ({
      id: r.id,
      pool: r.pool,
      n: Number(r.n),
      p: Number(r.p),
      r: r.r === null ? null : Number(r.r),
    }));
  }
}
