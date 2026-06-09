import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drop the legacy partial unique index `uniq_plan_default_per_country`
 * created in migration 1770 (PaymentProviderRefactor).
 *
 * That index encoded the OLD assumption "one default plan per country" —
 * valid when the catalogue had a single "Bondzi Pro GH" row. The
 * EntitlementsAndAccountTypes migration (1860) replaced that with the
 * per-slot constraint `subscription_plan_default_per_slot_uq` which
 * allows one default per `(country_code, account, level)` trio — six
 * defaults per country (Plus × {BECE,WASSCE,NOVDEC} + Pro × {…}).
 *
 * Migration 1860 SHOULD have dropped the old index in the same
 * transaction, but didn't — they coexisted, and the legacy single-slot
 * index rejected the second insert when `seed:plans:prod` ran on prod.
 * This migration cleans that up so fresh deploys don't trip on the
 * same conflict, and so any environment that already has 1860 applied
 * gets the old index removed on the next migrate.
 *
 * Idempotent: `drop index if exists` is a no-op when the index has
 * already been dropped manually (e.g. via psql to unblock the prod
 * seed). The new per-slot index is left untouched.
 */
export class DropLegacyPlanDefaultPerCountryIndex_1880000000000 implements MigrationInterface {
  name = 'DropLegacyPlanDefaultPerCountryIndex_1880000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `drop index if exists "uniq_plan_default_per_country";`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Re-create the legacy index on rollback. The "if not exists" guard
    // covers the case where 1860 is also being rolled back (which
    // re-creates this index via 1770's down()), so we don't double-create.
    await queryRunner.query(
      `create unique index if not exists "uniq_plan_default_per_country" ` +
        `on "subscription_plan" ("country_code") ` +
        `where is_default = true and is_active = true;`,
    );
  }
}
