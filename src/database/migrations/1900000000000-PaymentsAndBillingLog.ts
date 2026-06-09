import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Payments + BillingLog refactor (pre-launch).
 *
 * The old shape used `subscriptions` as a single state machine that
 * covered both "user attempted checkout" (status=past_due, no payment
 * yet) and "user has access" (status=active). That overload produced
 * the noisy admin Subscriptions page where one user shows up with 7+
 * rows — only one is a real entitlement; the rest are abandoned
 * checkouts. It also made it impossible to gate webhook acceptance on
 * "did we initiate this payment?" because every checkout intent
 * pre-created a `subscriptions` row before Paystack ever heard about
 * it.
 *
 * This migration:
 *
 *   1. Creates `payment_attempts` — every checkout attempt, regardless
 *      of outcome. New attempts are written here BEFORE Paystack is
 *      called. Webhooks gate on the reference matching a row in this
 *      table; a webhook for a reference we don't have is alarmed (it
 *      would otherwise be a fraud / mis-routed signal).
 *   2. Creates `billing_log` — append-only raw-payload sink. Every
 *      webhook lands here first (idempotent on provider_event_id),
 *      THEN we resolve and process. Carries the verbatim Paystack body
 *      so disputes ("we sent you a webhook") can be reconstructed
 *      months later. Replaces the older `financial_events` table —
 *      same role, richer schema (raw payload + processing audit).
 *   3. Normalises subscription statuses. The OLD `past_due` / `trial`
 *      / `inactive` values are no longer used by application code.
 *      Existing rows in those states (test data only — pre-launch)
 *      are migrated to `expired` so admin views stop showing them as
 *      pending or live. The DB enum keeps the legacy values (Postgres
 *      makes value removal painful and we don't lose anything by
 *      tolerating them; the TS code is the gate).
 *
 * Down path drops the new tables and leaves subscriptions untouched
 * (statuses can't be rolled back to past_due meaningfully — we'd lose
 * intent. Pre-launch this is acceptable; in production a richer
 * inverse would be required).
 */
export class PaymentsAndBillingLog_1900000000000 implements MigrationInterface {
  name = 'PaymentsAndBillingLog_1900000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // -------------------------------------------------------------------------
    // 1. Enums for the new tables.
    // -------------------------------------------------------------------------
    await queryRunner.query(`
      do $$ begin
        if not exists (select 1 from pg_type where typname = 'payment_attempt_status_enum') then
          create type "payment_attempt_status_enum" as enum (
            'pending', 'paid', 'failed', 'refunded', 'abandoned'
          );
        end if;
      end $$;
    `);
    await queryRunner.query(`
      do $$ begin
        if not exists (select 1 from pg_type where typname = 'billing_log_process_status_enum') then
          create type "billing_log_process_status_enum" as enum (
            'received', 'success', 'no_matching_payment', 'duplicate', 'error'
          );
        end if;
      end $$;
    `);

    // -------------------------------------------------------------------------
    // 2. payment_attempts — every checkout attempt, regardless of outcome.
    //
    // `provider_reference` is the unique key webhooks gate on. Both the
    // mobile `verify` callback and the server-to-server Paystack webhook
    // resolve this column to find the row to update.
    //
    // `subscription_id` is nullable BEFORE the payment lands — until we
    // confirm the charge, there's no subscription to point at. After
    // success, we link the attempt to the resulting subscription row so
    // the user's payment history can join cleanly.
    // -------------------------------------------------------------------------
    await queryRunner.query(`
      create table if not exists "payment_attempts" (
        "id" uuid primary key default gen_random_uuid(),
        "user_id" uuid not null references "users"("id") on delete cascade,
        "subscription_id" uuid references "subscriptions"("id") on delete set null,
        "plan_id" uuid references "subscription_plan"("id") on delete set null,
        "billing_interval" billing_interval_enum,
        "amount_minor" integer not null check ("amount_minor" >= 0),
        "amount_ghs" numeric(10,2) not null check ("amount_ghs" >= 0),
        "currency" text not null default 'GHS',
        "provider" text not null,
        "provider_reference" text not null unique,
        "provider_event_id" text,
        "provider_customer_id" text,
        "promo_code_id" uuid references "promo_codes"("id") on delete set null,
        "discount_amount" numeric(10,2),
        "status" payment_attempt_status_enum not null default 'pending',
        "initiated_at" timestamptz not null default now(),
        "paid_at" timestamptz,
        "failed_at" timestamptz,
        "refunded_at" timestamptz,
        "abandoned_at" timestamptz,
        "failure_reason" text,
        "metadata" jsonb,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now()
      );
    `);

    // Hot paths:
    //   - admin /admin/payments listing: by status + created_at DESC
    //   - user history: by user_id + initiated_at DESC
    //   - webhook handler: by provider_reference (covered by UNIQUE)
    //   - sweep job: pending rows older than N hours
    await queryRunner.query(`
      create index if not exists "idx_payment_attempts_user_initiated"
        on "payment_attempts" ("user_id", "initiated_at" desc);
    `);
    await queryRunner.query(`
      create index if not exists "idx_payment_attempts_status_created"
        on "payment_attempts" ("status", "created_at" desc);
    `);
    await queryRunner.query(`
      create index if not exists "idx_payment_attempts_subscription"
        on "payment_attempts" ("subscription_id")
        where "subscription_id" is not null;
    `);

    // -------------------------------------------------------------------------
    // 3. billing_log — raw webhook payloads + processing audit.
    //
    // Idempotency: `provider_event_id` is unique. A retry from Paystack
    // with the same event id is a no-op INSERT (ON CONFLICT DO NOTHING
    // at the application layer).
    //
    // `process_status` is the security signal: `no_matching_payment`
    // means "Paystack told us about a payment we never initiated" —
    // alarm.
    // -------------------------------------------------------------------------
    await queryRunner.query(`
      create table if not exists "billing_log" (
        "id" uuid primary key default gen_random_uuid(),
        "provider" text not null,
        "event_type" text not null,
        "provider_event_id" text not null,
        "reference" text,
        "user_id" uuid references "users"("id") on delete set null,
        "payment_attempt_id" uuid references "payment_attempts"("id") on delete set null,
        "subscription_id" uuid references "subscriptions"("id") on delete set null,
        "raw_payload" jsonb not null,
        "signature" text,
        "normalized" jsonb,
        "occurred_at" timestamptz,
        "received_at" timestamptz not null default now(),
        "processed_at" timestamptz,
        "process_status" billing_log_process_status_enum not null default 'received',
        "process_error" text,
        "created_at" timestamptz not null default now()
      );
    `);
    await queryRunner.query(`
      create unique index if not exists "uq_billing_log_provider_event"
        on "billing_log" ("provider", "provider_event_id");
    `);
    await queryRunner.query(`
      create index if not exists "idx_billing_log_received"
        on "billing_log" ("received_at" desc);
    `);
    await queryRunner.query(`
      create index if not exists "idx_billing_log_reference"
        on "billing_log" ("reference") where "reference" is not null;
    `);
    await queryRunner.query(`
      create index if not exists "idx_billing_log_user"
        on "billing_log" ("user_id") where "user_id" is not null;
    `);
    await queryRunner.query(`
      create index if not exists "idx_billing_log_process_status"
        on "billing_log" ("process_status")
        where "process_status" in ('no_matching_payment', 'error');
    `);

    // -------------------------------------------------------------------------
    // 4. Subscriptions: normalise pre-launch test data.
    //
    // The legacy PAST_DUE / TRIAL / INACTIVE statuses are no longer used
    // by application code. Existing rows are migrated to EXPIRED so the
    // admin view doesn't surface them as live. Pre-launch only — in
    // production a richer migration would preserve intent.
    // -------------------------------------------------------------------------
    // Postgres forbids using a newly-added enum literal in the same
    // transaction as `ALTER TYPE ... ADD VALUE` (55P04). TypeORM wraps
    // each migration in one transaction, so compare via ::text instead
    // of casting 'inactive' back to subscriptions_status_enum.
    await queryRunner.query(`
      alter type "subscriptions_status_enum"
        add value if not exists 'inactive';
    `);
    await queryRunner.query(`
      update "subscriptions"
        set "status" = 'expired'
        where "status"::text in ('past_due', 'trial', 'inactive');
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `drop index if exists "idx_billing_log_process_status";`,
    );
    await queryRunner.query(`drop index if exists "idx_billing_log_user";`);
    await queryRunner.query(
      `drop index if exists "idx_billing_log_reference";`,
    );
    await queryRunner.query(`drop index if exists "idx_billing_log_received";`);
    await queryRunner.query(
      `drop index if exists "uq_billing_log_provider_event";`,
    );
    await queryRunner.query(`drop table if exists "billing_log";`);

    await queryRunner.query(
      `drop index if exists "idx_payment_attempts_subscription";`,
    );
    await queryRunner.query(
      `drop index if exists "idx_payment_attempts_status_created";`,
    );
    await queryRunner.query(
      `drop index if exists "idx_payment_attempts_user_initiated";`,
    );
    await queryRunner.query(`drop table if exists "payment_attempts";`);

    // Enums dropped only if nothing else references them — Postgres will
    // refuse otherwise, which is fine for a rollback safety net.
    await queryRunner.query(
      `drop type if exists "billing_log_process_status_enum";`,
    );
    await queryRunner.query(
      `drop type if exists "payment_attempt_status_enum";`,
    );

    // Subscriptions status backfill is one-way; the old PAST_DUE rows
    // were already noise and we don't try to reconstruct them.
  }
}
