import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Email delivery audit trail, dedup keys, bounce tracking, and user
 * preference columns for engagement mail.
 */
export class EmailNotifications_1920000000000 implements MigrationInterface {
  name = 'EmailNotifications_1920000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table "users"
        add column if not exists "email_verified_at" timestamptz,
        add column if not exists "email_bounced_at" timestamptz,
        add column if not exists "email_unsubscribe_token" text,
        add column if not exists "email_weekly_digest_enabled" bool not null default true,
        add column if not exists "email_streak_nudges_enabled" bool not null default true,
        add column if not exists "email_level_up_enabled" bool not null default true,
        add column if not exists "email_marketing_enabled" bool not null default true;
    `);

    await queryRunner.query(`
      create unique index if not exists "users_email_unsubscribe_token_idx"
        on "users" ("email_unsubscribe_token")
        where "email_unsubscribe_token" is not null;
    `);

    // Google OAuth users are treated as verified at signup — backfill any
    // existing google-provider rows that predate this column.
    await queryRunner.query(`
      update "users"
      set "email_verified_at" = coalesce("email_verified_at", "created_at")
      where "auth_provider" = 'google'
        and "email" is not null
        and "email_verified_at" is null;
    `);

    await queryRunner.query(`
      create table if not exists "email_sends" (
        "id" uuid primary key default gen_random_uuid(),
        "user_id" uuid references "users"("id") on delete set null,
        "event" text not null,
        "to_email" text not null,
        "dedup_key" text,
        "resend_id" text,
        "status" text not null,
        "error" text,
        "created_at" timestamptz not null default now()
      );
    `);

    await queryRunner.query(`
      create unique index if not exists "email_sends_dedup_key_idx"
        on "email_sends" ("dedup_key")
        where "dedup_key" is not null;
    `);

    await queryRunner.query(`
      create index if not exists "idx_email_sends_user_created"
        on "email_sends" ("user_id", "created_at" desc);
    `);

    await queryRunner.query(`
      create index if not exists "idx_email_sends_event_created"
        on "email_sends" ("event", "created_at" desc);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists "email_sends";`);
    await queryRunner.query(
      `drop index if exists "users_email_unsubscribe_token_idx";`,
    );
    await queryRunner.query(`
      alter table "users"
        drop column if exists "email_verified_at",
        drop column if exists "email_bounced_at",
        drop column if exists "email_unsubscribe_token",
        drop column if exists "email_weekly_digest_enabled",
        drop column if exists "email_streak_nudges_enabled",
        drop column if exists "email_level_up_enabled",
        drop column if exists "email_marketing_enabled";
    `);
  }
}
