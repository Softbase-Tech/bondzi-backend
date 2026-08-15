import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Strip the `PM-` prefix and internal dashes from every existing
 * referral code. New layout: 7-character uppercase alphanumeric,
 * no separators — easier to type on a phone (see
 * `generateReferralCode` in auth.service.ts).
 *
 *   Before: `PM-A1B2-JOH`, `PM-C3D4-KWA`, `PM-ADMIN`
 *   After:  `A1B2JOH`,      `C3D4KWA`,     `ADMIN`
 *
 * `referral_events.referral_code` mirrors the users column so the
 * two tables stay in sync — bulk-update both in the same
 * transaction.
 *
 * Uniqueness: the original UNIQUE index on `users.referral_code`
 * remains valid because the transformation is deterministic and
 * preserves character content. Two codes that were unique before
 * (differ in some position of the [A-Z0-9] payload) stay unique
 * after; only the `PM-` prefix and dashes are removed.
 *
 * Backfill affects all existing users. Incoming registrations use
 * the new layout automatically via generateReferralCode.
 */
export class SimplifyReferralCodes_2050000000000 implements MigrationInterface {
  public async up(qr: QueryRunner): Promise<void> {
    // Users table.
    await qr.query(`
      UPDATE users
         SET referral_code = REPLACE(REPLACE(referral_code, 'PM-', ''), '-', '')
       WHERE referral_code LIKE 'PM-%' OR referral_code LIKE '%-%';
    `);
    // Mirror into referral_events so history + qualification joins
    // resolve against the new format.
    await qr.query(`
      UPDATE referral_events
         SET referral_code = REPLACE(REPLACE(referral_code, 'PM-', ''), '-', '')
       WHERE referral_code LIKE 'PM-%' OR referral_code LIKE '%-%';
    `);
  }

  public async down(qr: QueryRunner): Promise<void> {
    // Best-effort revert. We can't perfectly reconstruct the original
    // `PM-XXXX-YYY` shape without knowing where the split lived, so we
    // approximate by re-splitting after the 4th character. This
    // matches every code produced by the old generator (4 hex + 3
    // alpha) and every custom-seeded code that followed the same
    // shape (e.g. `PMADMIN` → `PM-ADMI-N` isn't ideal — the seed
    // adjusts to `ADMINGH` on the next seed run).
    //
    // If a rollback is genuinely required against a prod DB, prefer a
    // restore from snapshot; the down migration here is a safety net,
    // not a first-class reversal.
    await qr.query(`
      UPDATE users
         SET referral_code = 'PM-' || SUBSTRING(referral_code, 1, 4) || '-' || SUBSTRING(referral_code, 5)
       WHERE referral_code NOT LIKE 'PM-%'
         AND length(referral_code) = 7;
    `);
    await qr.query(`
      UPDATE referral_events
         SET referral_code = 'PM-' || SUBSTRING(referral_code, 1, 4) || '-' || SUBSTRING(referral_code, 5)
       WHERE referral_code NOT LIKE 'PM-%'
         AND length(referral_code) = 7;
    `);
  }
}
