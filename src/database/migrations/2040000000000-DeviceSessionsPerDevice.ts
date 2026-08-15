import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Widen `device_sessions` from ONE row per user → ONE row per
 * (user, device). Web + mobile can now stay signed in on the same
 * account concurrently instead of kicking each other out.
 *
 *   Before: UNIQUE (user_id)
 *   After:  UNIQUE (user_id, device_id)
 *
 * The wire protocol was already device-aware:
 *   - Refresh tokens carry `did` in the JWT payload.
 *   - Access tokens carry `did`; JwtStrategy validates it.
 *   - Login / register / verify-otp / google / exam-type all require
 *     `X-Device-ID` (header or body).
 * So no client change is needed once TokensService starts filtering
 * its lookups on device_id.
 *
 * Data safety:
 *   - Up: pre-existing rows are at most one per user; widening the
 *     UNIQUE index accepts every existing row unchanged.
 *   - Down: multi-device state must be collapsed to one row per user
 *     before restoring the single-column UNIQUE. Keep the newest row
 *     per user (by created_at DESC) and drop the rest so returning to
 *     the strict model does not require manual cleanup.
 */
export class DeviceSessionsPerDevice_2040000000000 implements MigrationInterface {
  public async up(qr: QueryRunner): Promise<void> {
    // Drop the single-column UNIQUE constraint that enforced
    // one-session-per-user.
    await qr.query(`DROP INDEX IF EXISTS "idx_device_sessions_user";`);
    await qr.query(`
      CREATE UNIQUE INDEX "idx_device_sessions_user_device"
        ON "device_sessions" ("user_id", "device_id");
    `);
  }

  public async down(qr: QueryRunner): Promise<void> {
    // Collapse to one row per user (keep the newest) so the reverse
    // UNIQUE(user_id) constraint can be applied without violation.
    await qr.query(`
      DELETE FROM device_sessions
      WHERE id NOT IN (
        SELECT DISTINCT ON (user_id) id
        FROM device_sessions
        ORDER BY user_id, created_at DESC
      );
    `);
    await qr.query(`DROP INDEX IF EXISTS "idx_device_sessions_user_device";`);
    await qr.query(`
      CREATE UNIQUE INDEX "idx_device_sessions_user"
        ON "device_sessions" ("user_id");
    `);
  }
}
