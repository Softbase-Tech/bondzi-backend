import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `account_deletions` — the queue/log that drives account removal.
 *
 * Two entry points feed it (see AccountDeletionReason):
 *   - inactivity     : the daily sweep schedules any account with no login
 *                      for 90 days (`users.last_active_at`).
 *   - user_requested : DELETE /users/me schedules a 90-day grace and signs
 *                      the user out; logging back in cancels it.
 *
 * At `delete_after` the sweep ANONYMISES the user (scrubs PII, frees the
 * username, is_active=false, deleted_at=NOW()) rather than hard-deleting —
 * `winners` references `users` with ON DELETE RESTRICT, so a row must survive
 * to keep historical leaderboard/XP/referral integrity intact.
 *
 * At most one live (`scheduled`) row per user — enforced by a partial unique
 * index so a cancelled/completed history can still accumulate.
 */
export class AccountDeletions_2080000000000 implements MigrationInterface {
  name = 'AccountDeletions_2080000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      do $$ begin
        create type "account_deletion_reason" as enum ('inactivity', 'user_requested');
      exception when duplicate_object then null; end $$;
    `);
    await queryRunner.query(`
      do $$ begin
        create type "account_deletion_status" as enum ('scheduled', 'cancelled', 'completed');
      exception when duplicate_object then null; end $$;
    `);

    await queryRunner.query(`
      create table if not exists "account_deletions" (
        "id"                  uuid primary key default gen_random_uuid(),
        "user_id"             uuid not null references "users"("id") on delete cascade,
        "reason"              "account_deletion_reason" not null,
        "status"              "account_deletion_status" not null default 'scheduled',
        -- When the account is purged if the user never returns.
        "delete_after"        timestamptz not null,
        -- Snapshot of users.last_active_at at scheduling time. A later
        -- last_active_at means the user came back → cancel.
        "reference_active_at" timestamptz,
        -- Warning emails sent (T-14 and T-7). NULL until sent.
        "warned_first_at"     timestamptz,
        "warned_final_at"     timestamptz,
        "cancelled_at"        timestamptz,
        "completed_at"        timestamptz,
        "created_at"          timestamptz not null default now(),
        "updated_at"          timestamptz not null default now()
      );
    `);

    // One live deletion per user; cancelled/completed rows don't count.
    await queryRunner.query(`
      create unique index if not exists "uq_account_deletions_active_user"
        on "account_deletions" ("user_id")
        where "status" = 'scheduled';
    `);
    // The sweep scans by status + delete_after every day.
    await queryRunner.query(`
      create index if not exists "idx_account_deletions_status_due"
        on "account_deletions" ("status", "delete_after");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `drop index if exists "idx_account_deletions_status_due";`,
    );
    await queryRunner.query(
      `drop index if exists "uq_account_deletions_active_user";`,
    );
    await queryRunner.query(`drop table if exists "account_deletions";`);
    await queryRunner.query(`drop type if exists "account_deletion_status";`);
    await queryRunner.query(`drop type if exists "account_deletion_reason";`);
  }
}
