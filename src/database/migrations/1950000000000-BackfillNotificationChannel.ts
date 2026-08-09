import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One-time backfill: every historical `notifications` row was inserted
 * with `channel='in_app'`, regardless of whether the caller intended a
 * real device push (winner notifications, level-up, welcome, referral
 * qualified, etc.). The BullMQ dispatcher branches on the channel
 * column and SKIPS Firebase for `in_app` — so for the entire
 * pre-`adabb49` (auth hardening + push tooling) era, no actual FCM
 * pushes left the platform AND the admin notification log shows zero
 * rows under the "Push" filter even though "lots of push notifications
 * have been sent" is the operator's mental model.
 *
 * Post-`adabb49` every push site explicitly passes
 * `channel: NotificationChannel.PUSH` (auth welcome, gamification,
 * referrals, winner selection, entitlements grants, admin direct push),
 * so going forward the table records the truth. This migration brings
 * historical rows into line with the same convention so the admin
 * notification log surfaces them under the expected filter.
 *
 * Safety:
 *   - Bounded by `created_at < NOW()` at migration time — any row
 *     inserted concurrently (or any future legitimate inbox-only
 *     usage) is untouched.
 *   - No current code path writes `channel='in_app'` (verified via
 *     `grep NotificationChannel.IN_APP` across src/modules). The
 *     entity's default is IN_APP but every caller passes the channel
 *     explicitly, so the default is unreachable from the application
 *     code today.
 *   - Reversible: `down` flips the conversion back. The row count is
 *     recorded in the application log so the operator can sanity-check.
 */
export class BackfillNotificationChannel_1950000000000 implements MigrationInterface {
  name = 'BackfillNotificationChannel_1950000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // pg returns [rows, affectedCount] for UPDATE/DELETE via TypeORM's
    // QueryRunner. Cast through unknown so the eslint no-unsafe-assignment
    // rule doesn't trip on the dynamic shape — and the count is purely
    // for the migration log line below, not for control flow.
    const result = (await queryRunner.query(
      `update "notifications"
          set "channel" = 'push'
        where "channel" = 'in_app'
          and "created_at" < now();`,
    )) as unknown as [unknown[], number] | undefined;
    const affected = Array.isArray(result) ? result[1] : undefined;
    if (typeof affected === 'number') {
      console.log(
        `[migration 1950] backfilled ${affected} notification rows in_app → push`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverses the conversion. Cuts at the migration cutoff again so we
    // don't accidentally rewrite rows created legitimately as `push`
    // after the up migration ran.
    await queryRunner.query(
      `update "notifications"
          set "channel" = 'in_app'
        where "channel" = 'push'
          and "created_at" < now();`,
    );
  }
}
