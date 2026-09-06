import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Repair `exam_answers.question_pool` for historical rows.
 *
 * submitAnswer never set the column, so its default ('past_paper')
 * stamped EVERY answer — quiz (pm_test) answers included. Grading was
 * unaffected (the grader resolved options from the exam's own pool),
 * but every read that joins through the answer's discriminator — the
 * admin exam detail, the AI post-exam review snippet — found nothing
 * for quiz answers.
 *
 * Repair is by ID EXISTENCE, not by the exam's flag: a row is flipped
 * to pm_test only when its question_id exists in pm_test_questions and
 * NOT in questions (and vice versa), which also corrects any rows the
 * submit-time fallback graded from the "other" table. Ambiguous rows
 * (id in both tables — practically impossible with UUIDs) are left
 * untouched.
 *
 * Down: not restorable (the pre-repair values were wrong, not
 * meaningful state) — no-op.
 */
export class RepairAnswerQuestionPool_2330000000000 implements MigrationInterface {
  name = 'RepairAnswerQuestionPool_2330000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "exam_answers" a
          SET "question_pool" = 'pm_test'
        WHERE a."question_pool" = 'past_paper'
          AND EXISTS (SELECT 1 FROM "pm_test_questions" p WHERE p."id" = a."question_id")
          AND NOT EXISTS (SELECT 1 FROM "questions" q WHERE q."id" = a."question_id")`,
    );
    await queryRunner.query(
      `UPDATE "exam_answers" a
          SET "question_pool" = 'past_paper'
        WHERE a."question_pool" = 'pm_test'
          AND EXISTS (SELECT 1 FROM "questions" q WHERE q."id" = a."question_id")
          AND NOT EXISTS (SELECT 1 FROM "pm_test_questions" p WHERE p."id" = a."question_id")`,
    );
  }

  public async down(): Promise<void> {
    // The pre-repair values were incorrect data, not meaningful state.
  }
}
