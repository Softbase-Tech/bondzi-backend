import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 0 of the automated-reporting brief: the two columns whose absence
 * makes a report metric uncomputable rather than merely awkward.
 *
 * 1. `subscriptions.cancelled_at`
 *
 *    The churn split (voluntary cancellation vs. lapse) needs to know
 *    *when* a cancellation happened, not just that the row is now
 *    `cancelled`. The status itself survives fine — contrary to an earlier
 *    reading, the hourly renewal cron only considers
 *    `ACTIVE|TRIAL|XP_CREDITED` rows, so a cancelled row is never flipped
 *    to `expired` and the distinction is intact. What is missing is purely
 *    the timestamp: `updated_at` is the only trace, and any later write to
 *    the row (a re-subscribe reusing it, an admin correction) overwrites
 *    it.
 *
 *    Existing rows are backfilled from `updated_at`. That is a proxy, not
 *    a fact: for the overwhelming majority of cancelled rows nothing has
 *    written to them since the cancel, so it is exact — but a row that was
 *    later reused by a renewal will carry the later moment. It is
 *    backfilled anyway because the alternative is that every cancellation
 *    before today is invisible to `ensureRange()` when it computes a past
 *    day, and a slightly-late historical date is more useful than a
 *    permanent hole. New rows get the real value.
 *
 * 2. `exams.abandoned_at`
 *
 *    Session abandonment currently has no timestamp of its own. Worse,
 *    `src/scripts/abandon-stale-exams.ts` sets `completed_at` when it
 *    marks a session abandoned, so `completed_at IS NOT NULL` — the
 *    obvious definition of "completed" — silently counts abandonments as
 *    completions. Reporting therefore keys completion off `status`, and
 *    this column gives abandonment its own honest timestamp.
 *
 * Both columns are nullable and additive: safe to run against a live
 * table, no rewrite, no lock beyond the brief ACCESS EXCLUSIVE that
 * `ADD COLUMN ... NULL` takes in modern Postgres.
 */
export class ReportingPrerequisites_2360000000000 implements MigrationInterface {
  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(
      `ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancelled_at timestamptz`,
    );
    // Proxy backfill — see the note above. Scoped to rows that are
    // currently cancelled and have no value yet, so re-running is a no-op.
    await qr.query(
      `UPDATE subscriptions
          SET cancelled_at = updated_at
        WHERE status = 'cancelled'
          AND cancelled_at IS NULL`,
    );
    // Partial index: the reporting query is
    // `WHERE cancelled_at::date = $1`, which only ever touches non-null
    // rows, and cancellations are a small fraction of the table.
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_subs_cancelled_at
         ON subscriptions (cancelled_at)
       WHERE cancelled_at IS NOT NULL`,
    );

    await qr.query(
      `ALTER TABLE exams ADD COLUMN IF NOT EXISTS abandoned_at timestamptz`,
    );
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_exams_abandoned_at
         ON exams (abandoned_at)
       WHERE abandoned_at IS NOT NULL`,
    );
  }

  public async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP INDEX IF EXISTS idx_exams_abandoned_at`);
    await qr.query(`ALTER TABLE exams DROP COLUMN IF EXISTS abandoned_at`);
    await qr.query(`DROP INDEX IF EXISTS idx_subs_cancelled_at`);
    await qr.query(
      `ALTER TABLE subscriptions DROP COLUMN IF EXISTS cancelled_at`,
    );
  }
}
