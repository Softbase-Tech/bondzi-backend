import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `weakness_narratives` — one AI-generated narrative per user per Accra
 * day per optional subject scope. Powers the mobile "AI insight" card
 * without burning a fresh Bedrock call every time the user re-opens the
 * screen.
 *
 * Composite PK on (user_id, day, subject_scope) rather than a synthetic
 * uuid: the read pattern is always `WHERE user_id = ? AND day = today AND
 * subject_scope = ?`, and dedup lives in the PK, not an app-side check.
 *
 * `subject_scope` is TEXT (not FK) — the narrative is scoped to either
 * a subject id OR the special sentinel `all` (cross-subject). A FK would
 * force us to make it nullable and lose the composite-PK guarantee, so
 * we accept a slightly weaker referential relationship in exchange for
 * cleaner dedup.
 */
export class WeaknessNarratives_2000000000000 implements MigrationInterface {
  name = 'WeaknessNarratives_2000000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `create table if not exists "weakness_narratives" (
         "user_id" uuid not null references "users"("id") on delete cascade,
         "day" date not null,
         "subject_scope" text not null default 'all',
         "narrative" text not null,
         "model" text not null,
         "generated_at" timestamptz not null default now(),
         primary key ("user_id", "day", "subject_scope")
       );`,
    );
    // Housekeeping: prune anything older than 30 days weekly (mirrors
    // the AI reject-log retention job). Index on `day` alone speeds up
    // the prune sweep — the PK on (user_id, day, subject_scope) doesn't
    // help it because the leading column is user_id.
    await queryRunner.query(
      `create index if not exists "idx_weakness_narratives_day"
         on "weakness_narratives" ("day");`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `drop index if exists "idx_weakness_narratives_day";`,
    );
    await queryRunner.query(`drop table if exists "weakness_narratives";`);
  }
}
