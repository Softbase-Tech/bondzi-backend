import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `gender` + `date_of_birth` to the users table.
 *
 * Both nullable so existing users (registered before this migration
 * ran) aren't broken. The mobile registration screen + admin
 * onboarding require both going forward, but historical accounts can
 * still authenticate without them — the SafeUser shape exposes them
 * as nullable on the read side too.
 *
 * `gender` is a Postgres enum to keep the canonical four values
 * (`male` / `female` / `other` / `prefer_not_to_say`) at the DB
 * boundary, matching the same pattern used for ExamType / SchoolLevel
 * / SubscriptionStatus. A free-text column would let bad client data
 * pollute analytics.
 */
export class UserGenderAndDob_1930000000000 implements MigrationInterface {
  name = 'UserGenderAndDob_1930000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      do $$ begin
        if not exists (select 1 from pg_type where typname = 'user_gender_enum') then
          create type "user_gender_enum" as enum (
            'male', 'female', 'other', 'prefer_not_to_say'
          );
        end if;
      end $$;
    `);
    await queryRunner.query(
      `alter table "users" add column if not exists "gender" user_gender_enum;`,
    );
    await queryRunner.query(
      `alter table "users" add column if not exists "date_of_birth" date;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `alter table "users" drop column if exists "date_of_birth";`,
    );
    await queryRunner.query(
      `alter table "users" drop column if exists "gender";`,
    );
    await queryRunner.query(`drop type if exists "user_gender_enum";`);
  }
}
