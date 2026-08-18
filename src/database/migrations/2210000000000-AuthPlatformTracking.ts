import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Platform tracking for auth:
 *   • users.signup_platform — where the account was created ('web'|'ios'|'android')
 *   • auth_login_events      — append-only login history with the platform per login
 */
export class AuthPlatformTracking_2210000000000 implements MigrationInterface {
  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_platform text`,
    );

    await qr.query(`
      CREATE TABLE IF NOT EXISTS auth_login_events (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        platform    text,
        event_type  text NOT NULL,
        device_id   text,
        ip_address  text,
        created_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_auth_login_events_user
         ON auth_login_events (user_id, created_at DESC)`,
    );
  }

  public async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS auth_login_events`);
    await qr.query(`ALTER TABLE users DROP COLUMN IF EXISTS signup_platform`);
  }
}
