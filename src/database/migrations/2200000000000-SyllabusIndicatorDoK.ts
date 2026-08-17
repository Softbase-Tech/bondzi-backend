import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Store the syllabus extraction's real per-indicator signal.
 *
 * A1 modelled assessment as child `syllabus_assessment_items` rows
 * (per‑question, per‑DoK — the Additional‑Maths shape). The pdfplumber
 * extraction actually yields, per indicator:
 *   - the bold DoK level(s) in the Assessment cell — usually one, sometimes
 *     a range (e.g. Physics `Level 2`–`Level 3`), so an int[].
 *   - the pedagogical exemplars (heading + bullet items) split off the
 *     indicator statement.
 * Both are added directly on the indicator. `syllabus_assessment_items`
 * stays for a future per‑question extraction but is unused by this path.
 */
export class SyllabusIndicatorDoK_2200000000000 implements MigrationInterface {
  name = 'SyllabusIndicatorDoK_2200000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE syllabus_indicators
        ADD COLUMN target_dok_levels int[],
        ADD COLUMN pedagogy_exemplars jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE syllabus_indicators
        DROP COLUMN IF EXISTS pedagogy_exemplars,
        DROP COLUMN IF EXISTS target_dok_levels
    `);
  }
}
