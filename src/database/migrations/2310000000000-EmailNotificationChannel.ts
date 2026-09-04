import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds 'email' to the notifications channel enum so broadcasts and
 * re-engagement can reach push-unreachable users (web signups with no
 * device token) through MailService. Postgres 12+ allows ADD VALUE
 * inside a transaction as long as the new value isn't used in the same
 * transaction (same pattern as migrations 1900 / 2250).
 */
export class EmailNotificationChannel2310000000000 implements MigrationInterface {
  name = 'EmailNotificationChannel2310000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_channel_enum" ADD VALUE IF NOT EXISTS 'email'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot remove enum values; rows written with 'email'
    // would block a type rebuild. Deliberate no-op.
  }
}
