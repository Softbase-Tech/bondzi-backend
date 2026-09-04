import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backfill the platform on historical operator sign-ins.
 *
 * `auth_login_events.platform` is stamped from the `X-Platform` request
 * header. The admin console (admin.bondzi.online) sent that header on its
 * regular API calls but *not* on the one call that actually mints a login
 * event — NextAuth's `authorize()` POST to /auth/login. Every admin sign-in
 * before this migration therefore landed with `platform = NULL` and renders
 * as the "Unknown" pill in auth analytics.
 *
 * The client is fixed alongside this migration; this repairs the history so
 * the operator/student split is accurate all the way back.
 *
 * Scope is deliberately narrow — only rows that are BOTH:
 *   • already NULL (never overwrite a platform we genuinely captured), and
 *   • owned by an admin/superadmin account.
 *
 * An admin who signed in through the *student* app carries a real 'web' /
 * 'android' value and is left alone: that is a student-surface session by a
 * staff account, and rewriting it would be inventing telemetry.
 *
 * Idempotent — re-running matches nothing once the NULLs are consumed.
 */
export class BackfillAdminLoginPlatform_2310000000000 implements MigrationInterface {
  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      UPDATE auth_login_events e
         SET platform = 'admin-web'
        FROM users u
       WHERE u.id = e.user_id
         AND e.platform IS NULL
         AND u.role IN ('admin', 'superadmin')
    `);
  }

  /**
   * Intentionally a no-op.
   *
   * Once this has run, a row reading 'admin-web' is indistinguishable from
   * one the fixed client captured legitimately — the two are the same value
   * by design. Reverting would blank real telemetry to undo a repair, so the
   * safe inverse of "filled in a NULL" is to leave it filled. Rolling the
   * schema back does not depend on this data.
   */
  public async down(): Promise<void> {
    // no-op — see above.
  }
}
