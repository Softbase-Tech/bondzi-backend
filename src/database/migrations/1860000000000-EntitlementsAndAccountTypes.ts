import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Entitlements + Account Types
 *
 * Restructures the subscription model from a binary (subscribed / not) into a
 * three-account, per-level entitlement model:
 *
 *   - Free  — implicit; never stored. Core subjects within the user's level
 *             + practice tests on those subjects + AI explanations on core.
 *   - Plus  — one-time payment, per level. Lifetime access to past + practice
 *             questions (core + electives) + AI explanations across the level.
 *   - Pro   — recurring subscription, per level. Everything in Plus + curated
 *             AI tests, weakness analytics, etc.
 *
 * `level` is the same as `exam_type` for the user — Plus on SHS does NOT grant
 * access on BECE or NOVDEC. Switching profile level falls back to Free for the
 * new level until that level is purchased.
 *
 * Schema work this migration performs:
 *
 *   1. Extends enums: exam_type (+ novdec), school_level (+ remedial),
 *      subscription_status (+ refunded). Creates new enums account_type,
 *      payment_kind, promo_discount_type.
 *   2. Allows users.form_level to be NULL (remedial users aren't in a school
 *      cohort — they sit WASSCE re-sits as private candidates).
 *   3. Extends subscription_plans with `account`, `level`, `payment_kind`,
 *      `vat_rate_pct` so the plan catalogue can express every Free/Plus/Pro
 *      × level combination. Existing rows backfill to (pro, wassce, recurring)
 *      because that mirrors the only plan shape in production until now.
 *   4. Creates promo_codes + promo_redemptions tables (discount codes redeemed
 *      at checkout — admin manages from the plans area).
 *   5. Creates legal_pages table for admin-editable refund-policy / terms /
 *      privacy documents — seeded with a placeholder refund-policy row.
 *
 * NOT in this migration:
 *
 *   - Admin grant/revoke audit log — reuses the existing `audit_log` table
 *     with action='entitlement.grant' / 'entitlement.revoke' /
 *     'entitlement.refund' / 'entitlement.extend'.
 *   - Entitlement resolution logic — lives in the service layer, no schema
 *     impact. A user's effective account on a level is computed from the
 *     subscriptions table (latest active row for that user × level × account).
 */
export class EntitlementsAndAccountTypes_1860000000000 implements MigrationInterface {
  name = 'EntitlementsAndAccountTypes_1860000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // -------------------------------------------------------------------------
    // 1. Enum extensions and new enums
    // -------------------------------------------------------------------------
    await queryRunner.query(`
      alter type "exam_type_enum"
        add value if not exists 'novdec' after 'wassce';
    `);
    await queryRunner.query(`
      alter type "school_level_enum"
        add value if not exists 'remedial' after 'shs';
    `);
    // NOTE: TypeORM names the enum after the table+column (plural table
    // here). The initial schema migration (1750) created it as
    // `subscriptions_status_enum`, NOT `subscription_status_enum`. An
    // earlier draft of this migration referenced the singular form and
    // 42704'd on a fresh DB run.
    await queryRunner.query(`
      alter type "subscriptions_status_enum"
        add value if not exists 'refunded' after 'xp_credited';
    `);

    await queryRunner.query(`
      do $$ begin
        if not exists (select 1 from pg_type where typname = 'account_type_enum') then
          create type "account_type_enum" as enum ('free', 'plus', 'pro');
        end if;
      end $$;
    `);
    await queryRunner.query(`
      do $$ begin
        if not exists (select 1 from pg_type where typname = 'payment_kind_enum') then
          create type "payment_kind_enum" as enum ('one_time', 'recurring');
        end if;
      end $$;
    `);
    await queryRunner.query(`
      do $$ begin
        if not exists (select 1 from pg_type where typname = 'promo_discount_type_enum') then
          create type "promo_discount_type_enum" as enum ('percent', 'fixed');
        end if;
      end $$;
    `);

    // -------------------------------------------------------------------------
    // 2. users.form_level becomes nullable for remedial users
    // -------------------------------------------------------------------------
    await queryRunner.query(`
      alter table "users"
        alter column "form_level" drop not null;
    `);

    // -------------------------------------------------------------------------
    // 3. subscription_plans gains account / level / payment_kind / vat_rate
    //
    // Existing rows (if any) are backfilled to (pro, wassce, recurring, 0) —
    // the only shape used pre-launch. After backfill, the columns are
    // tightened to NOT NULL.
    // -------------------------------------------------------------------------
    await queryRunner.query(`
      alter table "subscription_plans"
        add column if not exists "account" account_type_enum,
        add column if not exists "level" exam_type_enum,
        add column if not exists "payment_kind" payment_kind_enum,
        add column if not exists "vat_rate_pct" numeric(5,2) not null default 0;
    `);
    await queryRunner.query(`
      update "subscription_plans"
        set "account" = 'pro'::account_type_enum
        where "account" is null;
    `);
    await queryRunner.query(`
      update "subscription_plans"
        set "level" = 'wassce'::exam_type_enum
        where "level" is null;
    `);
    await queryRunner.query(`
      update "subscription_plans"
        set "payment_kind" = 'recurring'::payment_kind_enum
        where "payment_kind" is null;
    `);
    await queryRunner.query(`
      alter table "subscription_plans"
        alter column "account" set not null,
        alter column "level" set not null,
        alter column "payment_kind" set not null;
    `);
    // Partial unique index so only ONE default plan can exist per
    // (country, account, level) combination at a time — protects the admin
    // from accidentally activating two defaults that the checkout flow can't
    // disambiguate. Active-only by design: archived plans can share the slot.
    await queryRunner.query(`
      create unique index if not exists "subscription_plans_default_per_slot_uq"
        on "subscription_plans" ("country_code", "account", "level")
        where "is_default" = true and "is_active" = true;
    `);

    // -------------------------------------------------------------------------
    // 4. promo_codes + promo_redemptions
    //
    // promo_codes: catalogue of admin-created discount codes. `code` is stored
    // lowercased to make redemption case-insensitive without per-query work.
    // promo_redemptions: append-only ledger so the same user can't redeem the
    // same code twice and so admin can audit code performance.
    // -------------------------------------------------------------------------
    await queryRunner.query(`
      create table if not exists "promo_codes" (
        "id" uuid primary key default gen_random_uuid(),
        "code" text not null unique,
        "description" text,
        "discount_type" promo_discount_type_enum not null,
        "discount_value" numeric(10,2) not null check ("discount_value" >= 0),
        "applicable_account" account_type_enum,
        "applicable_level" exam_type_enum,
        "max_redemptions" integer check ("max_redemptions" is null or "max_redemptions" > 0),
        "redeemed_count" integer not null default 0 check ("redeemed_count" >= 0),
        "valid_from" timestamptz,
        "valid_until" timestamptz,
        "is_active" boolean not null default true,
        "created_by" uuid references "users"("id") on delete set null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        check ("valid_until" is null or "valid_from" is null or "valid_until" > "valid_from"),
        check (
          "discount_type" <> 'percent'
          or "discount_value" <= 100
        )
      );
    `);
    await queryRunner.query(`
      create index if not exists "promo_codes_code_lower_idx"
        on "promo_codes" (lower("code"));
    `);
    await queryRunner.query(`
      create index if not exists "promo_codes_active_idx"
        on "promo_codes" ("is_active") where "is_active" = true;
    `);

    await queryRunner.query(`
      create table if not exists "promo_redemptions" (
        "id" uuid primary key default gen_random_uuid(),
        "promo_code_id" uuid not null references "promo_codes"("id") on delete restrict,
        "user_id" uuid not null references "users"("id") on delete cascade,
        "subscription_id" uuid references "subscriptions"("id") on delete set null,
        "discount_amount" numeric(10,2) not null check ("discount_amount" >= 0),
        "currency" text not null,
        "redeemed_at" timestamptz not null default now()
      );
    `);
    await queryRunner.query(`
      create unique index if not exists "promo_redemptions_one_per_user_uq"
        on "promo_redemptions" ("promo_code_id", "user_id");
    `);
    await queryRunner.query(`
      create index if not exists "promo_redemptions_user_idx"
        on "promo_redemptions" ("user_id");
    `);

    // -------------------------------------------------------------------------
    // 5. legal_pages
    //
    // Single-table store for admin-editable static documents (refund policy,
    // terms, privacy). `slug` is the public identifier mobile/web fetch by.
    // -------------------------------------------------------------------------
    await queryRunner.query(`
      create table if not exists "legal_pages" (
        "id" uuid primary key default gen_random_uuid(),
        "slug" text not null unique,
        "title" text not null,
        "body" text not null,
        "updated_by" uuid references "users"("id") on delete set null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now()
      );
    `);
    // Seed the refund policy with a placeholder. Admin edits the body via the
    // admin panel; mobile reads it through the public /legal/:slug endpoint.
    // The actual policy text is product/legal's call — this is a marker so the
    // row exists and the screens have something to render on first load.
    await queryRunner.query(`
      insert into "legal_pages" ("slug", "title", "body")
      values (
        'refund-policy',
        'Refund Policy',
        '## Refund Policy

We want you to be confident in your Bondzi purchase. Please review the terms below before subscribing.

### One-time (Plus) purchases
- A Plus purchase grants lifetime access for the selected level (BECE, WASSCE or NOVDEC).
- Refund requests are honoured within 7 days of purchase if no premium content (past papers, AI explanations) has been accessed.
- After premium content has been accessed, Plus purchases are non-refundable.

### Recurring (Pro) subscriptions
- Pro subscriptions can be cancelled at any time from Settings → Subscription.
- Cancellation stops future renewals but does not refund the current billing period.
- Pro auto-renews at the start of each cycle; manage renewals from Settings.

### How to request a refund
Email support@bondzi.app with your account email and the payment reference. Refunds are processed back to your original Paystack payment method within 7 working days.

_Last updated: see "updated_at" on this page._'
      )
      on conflict ("slug") do nothing;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 5. legal_pages
    await queryRunner.query(`drop table if exists "legal_pages";`);

    // 4. promo_redemptions + promo_codes
    await queryRunner.query(`drop table if exists "promo_redemptions";`);
    await queryRunner.query(`drop table if exists "promo_codes";`);

    // 3. subscription_plans columns + unique index
    await queryRunner.query(`
      drop index if exists "subscription_plans_default_per_slot_uq";
    `);
    await queryRunner.query(`
      alter table "subscription_plans"
        drop column if exists "vat_rate_pct",
        drop column if exists "payment_kind",
        drop column if exists "level",
        drop column if exists "account";
    `);

    // 2. users.form_level back to NOT NULL — will fail if any remedial users
    // have been created. That's intentional: refusing to drop data > silently
    // discarding remedial users on rollback.
    await queryRunner.query(`
      alter table "users"
        alter column "form_level" set not null;
    `);

    // 1. New enums. We do NOT remove the values added to existing enums
    // (exam_type 'novdec', school_level 'remedial', subscription_status
    // 'refunded') — Postgres has no `drop value from enum` and the only safe
    // path (rename type, recreate, copy data) is more dangerous than leaving
    // the values orphaned on rollback.
    await queryRunner.query(`drop type if exists "promo_discount_type_enum";`);
    await queryRunner.query(`drop type if exists "payment_kind_enum";`);
    await queryRunner.query(`drop type if exists "account_type_enum";`);
  }
}
