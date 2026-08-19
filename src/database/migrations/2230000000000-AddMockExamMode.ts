import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The `exams_mode_enum` DB type was created in 1750000000000 with five
 * values: past_paper, practice, topic_drill, pm_test, srs_review.
 *
 * The application later added `MOCK_EXAM = 'mock_exam'` to the TypeScript
 * ExamMode enum, wired a full mock-exam code path (setup screen, service
 * branch, DTO validation) and shipped it to production — but no
 * migration added the value to the Postgres enum type. Result: every
 * "Start mock exam" tap survived DTO validation and every entitlement
 * check, then Postgres rejected the INSERT with SQLSTATE 22P02
 * ("invalid input value for enum exams_mode_enum: 'mock_exam'"). The
 * mobile client saw a bare 500, showed a very brief error toast, and
 * the user was left staring at the setup screen.
 *
 * This migration only adds the value — it does not USE it in the same
 * transaction, so it does not need `transaction: false`. Applying is
 * safe on any live database because `IF NOT EXISTS` is idempotent.
 */
export class AddMockExamMode_2230000000000 implements MigrationInterface {
  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(
      `ALTER TYPE "exams_mode_enum" ADD VALUE IF NOT EXISTS 'mock_exam'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres does not support dropping a single value from an enum
    // type without recreating the type entirely, which requires
    // rewriting every column that references it. Since new rows may
    // already reference 'mock_exam' by the time a rollback is
    // considered, leave the value in place — the value being present
    // in the enum but unused by the application is harmless.
  }
}
