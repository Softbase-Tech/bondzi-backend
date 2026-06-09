import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Idempotency for the long-lived financial_events ledger.
 *
 * Before this migration: a webhook delivered twice (Paystack retry
 * arriving while the first delivery was still mid-dispatch, or a
 * legitimate redelivery after a transient failure) wrote two
 * ACTIVATION / RENEWAL / REFUND rows for ONE charge. The
 * compliance-grade ledger we keep for 5–7 years would have
 * double-counted revenue across thousands of events over the
 * project's lifetime.
 *
 * After this migration:
 *   - `provider_event_id` is the dedup key for webhook-sourced rows
 *   - A partial unique index covers `(event_type, provider_event_id)`
 *     so the same (event_type, event_id) pair is only ever written
 *     once. The partial WHERE clause excludes non-webhook rows
 *     (`provider_event_id IS NULL`) so admin/system/job-sourced
 *     events keep their own dedup discipline at the caller.
 *
 * The application-level write path uses `ON CONFLICT DO NOTHING` so
 * a duplicate insert is a silent no-op rather than throwing — the
 * primary side effect (activation / refund) is unaffected by the
 * ledger's idempotency.
 */
export class FinancialEventsProviderEventIdIdempotency_1910000000001 implements MigrationInterface {
  name = 'FinancialEventsProviderEventIdIdempotency_1910000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `alter table "financial_events"
         add column if not exists "provider_event_id" text;`,
    );
    await queryRunner.query(
      `create unique index if not exists "uq_financial_events_event_type_provider_event_id"
         on "financial_events" ("event_type", "provider_event_id")
         where "provider_event_id" is not null;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `drop index if exists "uq_financial_events_event_type_provider_event_id";`,
    );
    await queryRunner.query(
      `alter table "financial_events" drop column if exists "provider_event_id";`,
    );
  }
}
