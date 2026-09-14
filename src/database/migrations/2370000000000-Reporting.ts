import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Automated reporting: the daily metric snapshot, the delivery ledger, and
 * the host-facts sink.
 *
 * `report_daily_snapshot` is the only table here that must never be
 * pruned. Raw tables already have retention policies (the AI reject log
 * prunes at 30 days) and more will follow; the snapshot is the sole
 * durable record of what the numbers *were*. A row is 3-5 KB, so ten years
 * is under 20 MB — there is no scale argument for ever deleting one.
 *
 * Rows are immutable by convention, which is why the activation cohort is
 * computed with a one-day lag: a user who signs up at 23:00 still has 23
 * hours of their activation window open when the 00:15 job fires, and a
 * snapshot written now is never revisited, so computing it same-day would
 * bake in a permanent undercount.
 */
export class Reporting_2370000000000 implements MigrationInterface {
  public async up(qr: QueryRunner): Promise<void> {
    // ---------------------------------------------------------------
    // Daily snapshot
    // ---------------------------------------------------------------
    //
    // `metrics` is jsonb so adding a metric is a code change, not a
    // migration. The generated columns below exist only for the handful
    // of headline figures that weekly/monthly reports scan across many
    // days — those become plain indexed integer reads instead of JSON
    // path extraction on every row.
    //
    // Each generated column guards its cast with a regex. A plain
    // `(metrics->...->>'signups')::int` would raise on any non-numeric
    // value and abort the INSERT — meaning one malformed metric would
    // lose the entire day's snapshot, including the dozens of metrics
    // that computed fine. The guard degrades a bad value to NULL and
    // keeps the row, which matches the module's rule everywhere else:
    // a broken collector degrades its own section and nothing more.
    await qr.query(`
      CREATE TABLE IF NOT EXISTS report_daily_snapshot (
        snapshot_date   date PRIMARY KEY,
        schema_version  smallint    NOT NULL DEFAULT 1,
        metrics         jsonb       NOT NULL,
        computed_at     timestamptz NOT NULL DEFAULT now(),
        compute_ms      integer,

        signups integer GENERATED ALWAYS AS (
          CASE WHEN metrics->'growth'->>'signups' ~ '^-?[0-9]+$'
               THEN (metrics->'growth'->>'signups')::int END
        ) STORED,
        dau integer GENERATED ALWAYS AS (
          CASE WHEN metrics->'engagement'->>'dau' ~ '^-?[0-9]+$'
               THEN (metrics->'engagement'->>'dau')::int END
        ) STORED,
        new_pro integer GENERATED ALWAYS AS (
          CASE WHEN metrics->'revenue'->>'new_pro_subs' ~ '^-?[0-9]+$'
               THEN (metrics->'revenue'->>'new_pro_subs')::int END
        ) STORED,
        revenue_ghs numeric(12,2) GENERATED ALWAYS AS (
          CASE WHEN metrics->'revenue'->>'revenue_ghs' ~ '^-?[0-9]+(\\.[0-9]+)?$'
               THEN (metrics->'revenue'->>'revenue_ghs')::numeric END
        ) STORED,
        ai_spend_usd numeric(12,4) GENERATED ALWAYS AS (
          CASE WHEN metrics->'ai'->>'spend_usd' ~ '^-?[0-9]+(\\.[0-9]+)?$'
               THEN (metrics->'ai'->>'spend_usd')::numeric END
        ) STORED
      )
    `);
    // The primary key already indexes snapshot_date ascending; weekly and
    // monthly reports read the most recent N days, which is a backwards
    // scan.
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_snapshot_date_desc
         ON report_daily_snapshot (snapshot_date DESC)`,
    );

    // ---------------------------------------------------------------
    // Delivery ledger
    // ---------------------------------------------------------------
    //
    // One row per (report_type, period_start), claimed BEFORE the send and
    // updated after. The UNIQUE constraint plus ON CONFLICT DO UPDATE is
    // what lets a failed attempt be retried in place — an earlier design
    // inserted a separate 'failed' row and then could never record 'sent'
    // for that period, permanently wedging it.
    //
    // This ledger is bookkeeping, not the double-send guard. That job
    // belongs to MailService's `email_sends.dedup_key`, which is claimed
    // atomically before the Resend call; a crash between send and ledger
    // update therefore cannot produce a second email.
    await qr.query(`
      CREATE TABLE IF NOT EXISTS report_deliveries (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        report_type   text NOT NULL CHECK (report_type IN ('daily','weekly','monthly')),
        period_start  date NOT NULL,
        period_end    date NOT NULL,
        recipients    text[] NOT NULL DEFAULT '{}',
        status        text NOT NULL CHECK (status IN ('sending','sent','failed','skipped')),
        attempt_count integer NOT NULL DEFAULT 1,
        provider_id   text,
        error         text,
        claimed_at    timestamptz NOT NULL DEFAULT now(),
        sent_at       timestamptz,
        CONSTRAINT uq_report_deliveries_period UNIQUE (report_type, period_start)
      )
    `);
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_report_deliveries_type_period
         ON report_deliveries (report_type, period_start DESC)`,
    );

    // ---------------------------------------------------------------
    // Host facts
    // ---------------------------------------------------------------
    //
    // Written by cron scripts on the box (backup.sh, host-stats.sh) via an
    // INSERT-only `ops_writer` role — the host cron must not hold the
    // app's credentials. Created now, populated in Phase 2; until then the
    // infra collector reads an empty table and renders those lines as
    // "no data" rather than failing.
    await qr.query(`
      CREATE TABLE IF NOT EXISTS ops_events (
        id          bigserial PRIMARY KEY,
        event_type  text NOT NULL,
        occurred_at timestamptz NOT NULL DEFAULT now(),
        payload     jsonb NOT NULL
      )
    `);
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_ops_events_type_time
         ON ops_events (event_type, occurred_at DESC)`,
    );
  }

  public async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS ops_events`);
    await qr.query(`DROP TABLE IF EXISTS report_deliveries`);
    await qr.query(`DROP TABLE IF EXISTS report_daily_snapshot`);
  }
}
