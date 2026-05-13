import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Provider-agnostic payments refactor (pre-ship).
 *
 *   1. Drops `subscription_price_config` (single-row legacy) — replaced by
 *      the versioned `subscription_plan` table.
 *   2. Creates `subscription_plan`: one row per product, bundles all three
 *      cadence prices + provider plan codes. Versioned via parent_plan_id.
 *   3. Introduces `billing_interval_enum` (monthly | six_month | annual).
 *   4. Rewrites `subscriptions`: drops the old plan enum column, adds
 *      plan_id / billing_interval / provider, renames the three paystack_*
 *      columns to provider_* so any gateway can populate them.
 *   5. Generalises `payment_events`: renames paystack_event_id to
 *      provider_event_id, adds a provider column, swaps the unique
 *      constraint to (provider, provider_event_id) so different providers
 *      never collide on IDs.
 */
export class PaymentProviderRefactor_1770000000000 implements MigrationInterface {
  name = 'PaymentProviderRefactor_1770000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- 1. Drop legacy price config ---------------------------------------
    await queryRunner.query(
      `drop table if exists "subscription_price_config" cascade;`,
    );

    // --- 2. New enum: billing_interval -------------------------------------
    await queryRunner.query(
      `create type "billing_interval_enum" as enum ('monthly','six_month','annual');`,
    );

    // --- 3. subscription_plan table ----------------------------------------
    await queryRunner.query(`
      create table "subscription_plan" (
        "id" uuid primary key default gen_random_uuid(),
        "name" text not null,
        "description" text,
        "country_code" text not null,
        "currency" text not null,
        "provider" text not null,
        "monthly_price" numeric(10,2) not null,
        "six_month_price" numeric(10,2) not null,
        "annual_price" numeric(10,2) not null,
        "monthly_duration_days" int not null default 30,
        "six_month_duration_days" int not null default 180,
        "annual_duration_days" int not null default 365,
        "provider_plan_monthly" text,
        "provider_plan_six_month" text,
        "provider_plan_annual" text,
        "is_active" boolean not null default true,
        "is_default" boolean not null default false,
        "version" int not null default 1,
        "parent_plan_id" uuid references "subscription_plan"("id") on delete set null,
        "created_by" uuid references "users"("id") on delete set null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now()
      );
    `);
    await queryRunner.query(
      `create index "idx_plan_country_active" on "subscription_plan" ("country_code","is_active");`,
    );
    await queryRunner.query(
      `create index "idx_plan_parent" on "subscription_plan" ("parent_plan_id");`,
    );
    // Only one default plan per country among active plans.
    await queryRunner.query(
      `create unique index "uniq_plan_default_per_country" on "subscription_plan" ("country_code") where is_default = true and is_active = true;`,
    );

    // --- 4. Rewrite subscriptions ------------------------------------------
    await queryRunner.query(`alter table "subscriptions" drop column "plan";`);
    await queryRunner.query(`drop type "subscriptions_plan_enum";`);

    await queryRunner.query(
      `alter table "subscriptions" add column "plan_id" uuid references "subscription_plan"("id") on delete set null;`,
    );
    await queryRunner.query(
      `alter table "subscriptions" add column "billing_interval" "billing_interval_enum";`,
    );
    await queryRunner.query(
      `alter table "subscriptions" add column "provider" text;`,
    );
    await queryRunner.query(
      `alter table "subscriptions" rename column "paystack_ref" to "provider_reference";`,
    );
    await queryRunner.query(
      `alter table "subscriptions" rename column "paystack_sub_code" to "provider_subscription_id";`,
    );
    await queryRunner.query(
      `alter table "subscriptions" rename column "paystack_customer" to "provider_customer_id";`,
    );

    // --- 5. Generalise payment_events --------------------------------------
    await queryRunner.query(
      `alter table "payment_events" drop constraint if exists "payment_events_paystack_event_id_key";`,
    );
    await queryRunner.query(
      `drop index if exists "payment_events_paystack_id_uq";`,
    );
    await queryRunner.query(
      `alter table "payment_events" rename column "paystack_event_id" to "provider_event_id";`,
    );
    await queryRunner.query(
      `alter table "payment_events" add column "provider" text not null default 'paystack';`,
    );
    // Drop the default — application code always sets it from now on.
    await queryRunner.query(
      `alter table "payment_events" alter column "provider" drop default;`,
    );
    await queryRunner.query(
      `create unique index "payment_events_provider_event_uq" on "payment_events" ("provider","provider_event_id");`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // --- Reverse payment_events --------------------------------------------
    await queryRunner.query(
      `drop index if exists "payment_events_provider_event_uq";`,
    );
    await queryRunner.query(
      `alter table "payment_events" drop column "provider";`,
    );
    await queryRunner.query(
      `alter table "payment_events" rename column "provider_event_id" to "paystack_event_id";`,
    );
    await queryRunner.query(
      `create unique index "payment_events_paystack_id_uq" on "payment_events" ("paystack_event_id");`,
    );

    // --- Reverse subscriptions ---------------------------------------------
    await queryRunner.query(
      `alter table "subscriptions" rename column "provider_customer_id" to "paystack_customer";`,
    );
    await queryRunner.query(
      `alter table "subscriptions" rename column "provider_subscription_id" to "paystack_sub_code";`,
    );
    await queryRunner.query(
      `alter table "subscriptions" rename column "provider_reference" to "paystack_ref";`,
    );
    await queryRunner.query(
      `alter table "subscriptions" drop column "provider";`,
    );
    await queryRunner.query(
      `alter table "subscriptions" drop column "billing_interval";`,
    );
    await queryRunner.query(
      `alter table "subscriptions" drop column "plan_id";`,
    );
    await queryRunner.query(
      `create type "subscriptions_plan_enum" as enum ('free','monthly','termly','annual','xp_credit');`,
    );
    await queryRunner.query(
      `alter table "subscriptions" add column "plan" "subscriptions_plan_enum" not null default 'free';`,
    );
    await queryRunner.query(
      `alter table "subscriptions" alter column "plan" drop default;`,
    );

    // --- Drop subscription_plan --------------------------------------------
    await queryRunner.query(
      `drop index if exists "uniq_plan_default_per_country";`,
    );
    await queryRunner.query(`drop index if exists "idx_plan_parent";`);
    await queryRunner.query(`drop index if exists "idx_plan_country_active";`);
    await queryRunner.query(
      `drop table if exists "subscription_plan" cascade;`,
    );
    await queryRunner.query(`drop type if exists "billing_interval_enum";`);

    // --- Restore legacy price config ---------------------------------------
    await queryRunner.query(`
      create table "subscription_price_config" (
        "id" uuid primary key default gen_random_uuid(),
        "monthly_price_ghs" numeric(10,2) not null,
        "termly_multiplier" numeric(5,2) not null default 2.5,
        "annual_multiplier" numeric(5,2) not null default 9.0,
        "currency" text not null default 'GHS',
        "paystack_plan_monthly" text,
        "paystack_plan_termly"  text,
        "paystack_plan_annual"  text,
        "is_active" boolean not null default true,
        "updated_by" uuid references "users"("id") on delete set null,
        "updated_at" timestamptz not null default now()
      );
    `);
  }
}
