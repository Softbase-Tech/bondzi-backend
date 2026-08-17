import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PART A / A1b — link the question pools to the NaCCA curriculum spine.
 *
 * Adds a nullable `syllabus_indicator_id` FK (ON DELETE SET NULL) to:
 *   - pm_test_questions  → the canonical link for AI-generated items,
 *     superseding the deprecated `syllabus_topic_id`.
 *   - questions (past papers) → populated later by the semantic
 *     past-paper→indicator backfill (plan §A7).
 *
 * The old `syllabus_topic_id` on pm_test_questions is intentionally left
 * in place (nullable, deprecated) so the existing generation/selection
 * code paths keep working during the transition. It is dropped, together
 * with the shallow `syllabus_topics` table, in a later cleanup migration
 * once all consumers read indicators.
 *
 * SET NULL (not CASCADE): deleting a syllabus indicator must never delete
 * a real question — it just detaches the link.
 */
export class QuestionSyllabusLink_2170000000000 implements MigrationInterface {
  name = 'QuestionSyllabusLink_2170000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE pm_test_questions
      ADD COLUMN syllabus_indicator_id uuid
        REFERENCES syllabus_indicators(id) ON DELETE SET NULL
    `);
    await queryRunner.query(`
      CREATE INDEX idx_pm_test_questions_syllabus_indicator
        ON pm_test_questions (syllabus_indicator_id)
    `);

    await queryRunner.query(`
      ALTER TABLE questions
      ADD COLUMN syllabus_indicator_id uuid
        REFERENCES syllabus_indicators(id) ON DELETE SET NULL
    `);
    await queryRunner.query(`
      CREATE INDEX idx_questions_syllabus_indicator
        ON questions (syllabus_indicator_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_questions_syllabus_indicator`,
    );
    await queryRunner.query(
      `ALTER TABLE questions DROP COLUMN IF EXISTS syllabus_indicator_id`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_pm_test_questions_syllabus_indicator`,
    );
    await queryRunner.query(
      `ALTER TABLE pm_test_questions DROP COLUMN IF EXISTS syllabus_indicator_id`,
    );
  }
}
