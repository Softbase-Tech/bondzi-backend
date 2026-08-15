import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds refresh-token rotation grace to `device_sessions`.
 *
 *   previous_refresh_jti      — the OUTGOING jti captured at the moment
 *                                the current jti was minted. NULL on a
 *                                brand-new session and cleared once the
 *                                grace window elapses.
 *   previous_jti_expires_at   — when the previous jti stops being
 *                                accepted (typically now() + 60 s at
 *                                each rotation).
 *
 * Motivation: the mobile app can rotate a refresh token, have the server
 * commit the new JTI, and then LOSE the response before persisting it
 * (app force-killed mid-response, TCP reset, cellular flap). On the next
 * launch it presents the stale JTI, the server sees it doesn't match the
 * current one, and returns DEVICE_KICKED even though no other device was
 * ever involved. The grace window admits the previous JTI for a short
 * period so those honest races don't bounce the user out.
 *
 * See the entity docstring on DeviceSession for the security tradeoff.
 */
export class DeviceSessionRefreshGrace_2030000000000 implements MigrationInterface {
  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      ALTER TABLE device_sessions
        ADD COLUMN previous_refresh_jti text,
        ADD COLUMN previous_jti_expires_at timestamptz
    `);
  }

  public async down(qr: QueryRunner): Promise<void> {
    await qr.query(`
      ALTER TABLE device_sessions
        DROP COLUMN previous_jti_expires_at,
        DROP COLUMN previous_refresh_jti
    `);
  }
}
