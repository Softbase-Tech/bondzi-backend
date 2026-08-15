import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `target_exam_date` to the users table.
 *
 * Optional per-user override for the "next exam" countdown on the
 * Profile screen. Without it, mobile falls back to a client-side
 * heuristic (May 15 for WASSCE, June 15 for BECE, Oct 15 for NOVDEC).
 * With it, mobile shows a real number that the student themself
 * confirmed.
 *
 * Nullable — historical accounts + accounts that skipped the
 * registration question keep working, and mobile treats null as
 * "no exam date set" (renders the empty state on the profile card).
 * Users can set / clear the date via PATCH /users/me at any time.
 */
export class UserTargetExamDate_2120000000000 implements MigrationInterface {
  name = 'UserTargetExamDate_2120000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `alter table "users" add column if not exists "target_exam_date" date;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `alter table "users" drop column if exists "target_exam_date";`,
    );
  }
}
