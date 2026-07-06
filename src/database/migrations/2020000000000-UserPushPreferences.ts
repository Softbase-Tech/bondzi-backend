import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds two push notification opt-outs to `users`. Both default TRUE
 * so existing users continue receiving reminders until they
 * explicitly opt out — matching the email-preference pattern
 * (email_streak_nudges_enabled etc, added earlier). Push preferences
 * are separate from email preferences because their cadence and
 * disruptiveness differ: a user may want daily push nudges but not
 * daily email digests, or vice versa.
 *
 *   push_reminders_enabled       — daily "ready to practise" + Monday
 *                                   leaderboard push
 *   push_streak_nudges_enabled   — the 17:00 "streak at risk" push
 *
 * Kept as two separate flags (not one blanket "push_enabled") because
 * streak nudges are urgency-driven and users often want THOSE even
 * when they've muted the routine daily-reminder cadence.
 */
export class UserPushPreferences_2020000000000 implements MigrationInterface {
  name = 'UserPushPreferences_2020000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `alter table "users"
         add column if not exists "push_reminders_enabled" boolean not null default true,
         add column if not exists "push_streak_nudges_enabled" boolean not null default true;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `alter table "users"
         drop column if exists "push_reminders_enabled",
         drop column if exists "push_streak_nudges_enabled";`,
    );
  }
}
