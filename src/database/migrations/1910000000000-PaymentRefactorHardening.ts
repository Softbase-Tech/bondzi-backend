import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Payment refactor hardening (pre-launch follow-up).
 *
 * Adds a partial index supporting the admin /admin/payments
 * `?alarm=duplicate_plus` filter. The filter surfaces payment_attempts
 * rows whose `metadata.alarmDuplicatePlus = true` — these are charges
 * for a Plus level the user already owned. The system flags but never
 * silently absorbs a duplicate Plus charge, so ops can issue the
 * Paystack refund manually.
 *
 * Why a partial index: the alarm population is small (single-digit per
 * thousand attempts in steady state), so the index is tiny while still
 * giving an O(1) lookup for the admin filter. A full GIN index over
 * the metadata jsonb would be wasteful here.
 */
export class PaymentRefactorHardening_1910000000000 implements MigrationInterface {
  name = 'PaymentRefactorHardening_1910000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create index if not exists "idx_payment_attempts_alarm_duplicate_plus"
        on "payment_attempts" ((metadata->>'alarmDuplicatePlus'))
        where (metadata->>'alarmDuplicatePlus') = 'true';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `drop index if exists "idx_payment_attempts_alarm_duplicate_plus";`,
    );
  }
}
