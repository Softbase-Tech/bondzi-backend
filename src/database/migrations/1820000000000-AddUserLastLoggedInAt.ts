import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Activates `users.last_active_at` as the canonical "last login /
 * last active" timestamp.
 *
 * The column existed (added by InitialSchemaV2) but no code wrote to
 * it. This migration:
 *   - Backfills existing rows from `device_sessions.created_at` (the
 *     closest existing proxy — single-device enforcement deletes +
 *     re-inserts the row on every fresh login, so each user's
 *     newest session row is their most recent fresh login).
 *   - Indexes the column DESC NULLS LAST so the admin "most-recently-
 *     active first" sort short-circuits the sort step.
 *
 * After this migration, `TokensService.issuePair()` stamps
 * `last_active_at = NOW()` on every credential login, OTP verify,
 * Google sign-in, registration, AND refresh-token rotation — so the
 * column tracks "last time the user proved possession of an auth
 * artifact", which is the practical signal admins want for
 * "active / dormant users".
 */
export class AddUserLastLoggedInAt_1820000000000 implements MigrationInterface {
  name = 'AddUserLastLoggedInAt_1820000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The column already exists from InitialSchemaV2; this is idempotent
    // in case of a partial deploy. Future-proof against a hand-dropped
    // column on a forked DB.
    await queryRunner.query(`
      alter table "users"
      add column if not exists "last_active_at" timestamptz;
    `);

    // Backfill from the latest device_sessions row per user. Skips
    // users who already have a value (a partial-deploy retry won't
    // overwrite anything).
    await queryRunner.query(`
      update "users" u
      set "last_active_at" = ds.last_session_at
      from (
        select user_id, max(created_at) as last_session_at
        from "device_sessions"
        group by user_id
      ) ds
      where ds.user_id = u.id
        and u.last_active_at is null;
    `);

    await queryRunner.query(`
      create index if not exists "idx_users_last_active_at"
        on "users" ("last_active_at" desc nulls last);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop index if exists "idx_users_last_active_at";`);
    // We DO NOT drop the column on rollback — it was created by
    // InitialSchemaV2 and dropping it would corrupt that migration's
    // shape. Only the index + backfill values are this migration's
    // responsibility.
  }
}
