import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Introduces a public `username` handle for users — primarily so the
 * leaderboard / Hall of Fame can display a stable, user-chosen name
 * instead of the legal `full_name` (which is often a real name people
 * don't want broadcast on a public board).
 *
 * Design notes:
 *   - Nullable on rollout so accounts created before this migration
 *     keep working. The mobile client forces an "set your username"
 *     modal on first session after the deploy, so the back-fill
 *     happens organically.
 *   - Case-insensitive uniqueness via a unique expression index on
 *     `lower(username)` rather than citext. Keeps the column a plain
 *     `text` (no extension dependency) while still preventing the
 *     "Ekow vs ekow" collision.
 *   - `username_changed_at` powers the 90-day cooldown enforced at
 *     the service layer. NULL means "never set" — first-time
 *     back-fill is free; second and subsequent changes are gated.
 *   - Format rules (length ≥ 6, [A-Za-z0-9] only) live in the DTO
 *     validator. We intentionally don't add a CHECK constraint at
 *     the DB layer so reserved-word lists / future format tweaks
 *     don't require a migration.
 */
export class AddUsername_1940000000000 implements MigrationInterface {
  name = 'AddUsername_1940000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `alter table "users" add column if not exists "username" text;`,
    );
    await queryRunner.query(
      `alter table "users" add column if not exists "username_changed_at" timestamptz;`,
    );
    await queryRunner.query(
      `create unique index if not exists "users_username_lower_unique"
         on "users" (lower("username"))
         where "username" is not null;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `drop index if exists "users_username_lower_unique";`,
    );
    await queryRunner.query(
      `alter table "users" drop column if exists "username_changed_at";`,
    );
    await queryRunner.query(
      `alter table "users" drop column if exists "username";`,
    );
  }
}
