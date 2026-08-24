import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * First-touch signup attribution.
 *
 * `users.signup_platform` (migration 2210) already records *what kind of
 * client* created the account — web / ios / android. These six columns
 * record *where the student came from* before that: the campaign that
 * produced the signup.
 *
 * Columns mirror the UTM vocabulary because that is what every ad
 * network, link shortener and analytics tool already speaks, so no
 * translation table is needed to read them:
 *
 *   signup_source    utm_source    'facebook'
 *   signup_medium    utm_medium    'group'
 *   signup_campaign  utm_campaign  'aug26'
 *   signup_content   utm_content   'p02_novdec'   ← per-post code
 *   signup_term      utm_term      'wassce_2026_gh' ← per-group code
 *   signup_referrer  raw           document.referrer (web), or the raw
 *                                  Play Install Referrer string (android)
 *
 * Written once, on INSERT only — see `AuthService.register` and the
 * Google sign-in path. Nothing updates them afterwards, which is what
 * makes the attribution first-touch: a student who arrives again later
 * from a different campaign does not overwrite the original.
 *
 * Deliberately columns on `users` rather than a side table: the read
 * pattern is a whole-table rollup (`GROUP BY signup_content`), it keeps
 * the analytics query join-free, and it sits next to `signup_platform`
 * which is the same class of fact.
 */
export class SignupAttribution_2300000000000 implements MigrationInterface {
  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS signup_source   text,
        ADD COLUMN IF NOT EXISTS signup_medium   text,
        ADD COLUMN IF NOT EXISTS signup_campaign text,
        ADD COLUMN IF NOT EXISTS signup_content  text,
        ADD COLUMN IF NOT EXISTS signup_term     text,
        ADD COLUMN IF NOT EXISTS signup_referrer text
    `);

    // Partial index: the overwhelming majority of rows are NULL
    // (organic / pre-launch signups), and every question worth asking
    // of this data filters them out anyway — "which post produced
    // signups" is meaningless for a row with no campaign. Indexing
    // only the attributed rows keeps it small.
    await qr.query(`
      CREATE INDEX IF NOT EXISTS idx_users_signup_attribution
        ON users (signup_content, signup_source)
        WHERE signup_content IS NOT NULL
    `);
  }

  public async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP INDEX IF EXISTS idx_users_signup_attribution`);
    await qr.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS signup_source,
        DROP COLUMN IF EXISTS signup_medium,
        DROP COLUMN IF EXISTS signup_campaign,
        DROP COLUMN IF EXISTS signup_content,
        DROP COLUMN IF EXISTS signup_term,
        DROP COLUMN IF EXISTS signup_referrer
    `);
  }
}
