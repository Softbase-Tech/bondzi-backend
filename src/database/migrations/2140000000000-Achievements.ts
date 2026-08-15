import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the achievements catalogue + per-user progress rows.
 *
 * Two tables:
 *   • achievements — the catalogue. Admin CRUD writes here. Each row
 *     names an aspirational milestone (icon, gradient, threshold),
 *     and threshold_type + threshold_value + min_answers together
 *     describe the unlock rule.
 *   • user_achievements — sparse per-user row per achievement. NULL
 *     unlocked_at means "in progress"; once evaluated as unlocked the
 *     row is upserted with unlocked_at = now(). progress_snapshot
 *     records the latest evaluated value for admin dashboards.
 *
 * Seed data: five milestones matching the old hardcoded strip on the
 * mobile profile screen (50 answers, 5-day streak, 70% accuracy on
 * 20+, level 10, 14-day longest streak) so students don't see an
 * empty strip on first deploy.
 */
export class Achievements_2140000000000 implements MigrationInterface {
  name = 'Achievements_2140000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ─── Catalogue ──────────────────────────────────────────────
    await queryRunner.query(`
      create table if not exists "achievements" (
        "id" uuid primary key default gen_random_uuid(),
        "key" text unique not null,
        "title" text not null,
        "description" text,
        "metric_key" text not null,
        "threshold_value" integer not null,
        "min_answers" integer,
        "icon_key" text not null,
        "gradient_start" text not null,
        "gradient_end" text not null,
        "sort_order" integer not null default 0,
        "is_active" boolean not null default true,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now()
      );
    `);
    await queryRunner.query(
      `create index if not exists "idx_achievements_active_sort" on "achievements" ("is_active", "sort_order");`,
    );
    // Explicit metric_key set — the service enum-narrows at read time
    // but keeping a CHECK here means bad admin input is rejected at
    // the DB boundary, not silently ignored later.
    await queryRunner.query(`
      alter table "achievements"
      add constraint "chk_achievements_metric_key"
      check (
        "metric_key" in (
          'answers_count',
          'streak_max',
          'longest_streak',
          'accuracy_pct',
          'level'
        )
      );
    `);

    // ─── Per-user progress ──────────────────────────────────────
    await queryRunner.query(`
      create table if not exists "user_achievements" (
        "id" uuid primary key default gen_random_uuid(),
        "user_id" uuid not null references "users"("id") on delete cascade,
        "achievement_id" uuid not null references "achievements"("id") on delete cascade,
        "unlocked_at" timestamptz,
        "progress_snapshot" integer not null default 0,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        unique ("user_id", "achievement_id")
      );
    `);
    await queryRunner.query(
      `create index if not exists "idx_user_achievements_user_unlocked" on "user_achievements" ("user_id", "unlocked_at");`,
    );

    // ─── Seed the current five ─────────────────────────────────
    // Colours match the mobile client's previous hardcoded strip so
    // the look survives the migration one-for-one.
    await queryRunner.query(`
      insert into "achievements"
        ("key","title","description","metric_key","threshold_value","min_answers","icon_key","gradient_start","gradient_end","sort_order")
      values
        ('first-50','50 answers','Answer 50 practice questions.','answers_count',50,null,'check','#06D6A0','#0AA47C',10),
        ('streak-5','5-day streak','Study on five different days in a row.','streak_max',5,null,'flame','#FF6B35','#E55A26',20),
        ('accuracy-70','70% accuracy','Hit 70% accuracy after 20+ answers.','accuracy_pct',70,20,'sparkle','#7C3AED','#5B21B6',30),
        ('level-10','Level 10','Reach level 10.','level',10,null,'star','#FFB020','#E48908',40),
        ('streak-14','14-day streak','Keep your longest streak at 14 or higher.','longest_streak',14,null,'trophy','#F43F5E','#BE123C',50)
      on conflict ("key") do nothing;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists "user_achievements";`);
    await queryRunner.query(`drop table if exists "achievements";`);
  }
}
