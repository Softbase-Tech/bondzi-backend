import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drop `exam_answers.selected_option_id` → `options(id)` FK.
 *
 * exam_answers serves BOTH past-paper questions (options live in
 * `options`) and PM-Test questions (options live in `pm_test_options`).
 * The `question_id` column already has its FK dropped for this exact
 * dual-target reason; the option FK was missed.
 *
 * Without this drop, any PM-Test answer submission with a non-null
 * selected_option_id fails at the DB level (FK violation against
 * `options`) even though the id is valid in `pm_test_options`.
 *
 * Integrity is enforced at the application layer: ExamsService.
 * submitAnswer validates the selectedOptionId against the correct
 * table based on `exam.questionPool` BEFORE inserting.
 */
export class DropExamAnswerOptionFk_1840000000000 implements MigrationInterface {
  name = 'DropExamAnswerOptionFk_1840000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The constraint name is the TypeORM auto-generated form
    // `exam_answers_selected_option_id_fkey`. Wrap in a DO block so
    // a partial-deploy retry doesn't fail on a missing constraint.
    await queryRunner.query(`
      do $$
      begin
        if exists (
          select 1 from pg_constraint
          where conname = 'exam_answers_selected_option_id_fkey'
        ) then
          alter table "exam_answers"
            drop constraint "exam_answers_selected_option_id_fkey";
        end if;
      end$$;
    `);
  }

  public down(_queryRunner: QueryRunner): Promise<void> {
    // Restoring the FK would reject every existing PM-Test answer
    // row whose selected_option_id points at pm_test_options. Down
    // is a no-op on purpose — a true rollback also needs a backfill
    // strategy for those rows, which is product-policy not schema.
    void _queryRunner;
    return Promise.resolve();
  }
}
