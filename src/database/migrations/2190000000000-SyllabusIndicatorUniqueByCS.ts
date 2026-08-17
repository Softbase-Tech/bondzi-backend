import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Correct the syllabus indicator uniqueness scope.
 *
 * A1 (migration 2160) assumed NaCCA Learning-Indicator codes are unique per
 * subject. They are NOT — LI/AS numbering RESETS inside each Content Standard.
 * Verified on the Chemistry curriculum: e.g. `1.1.1.LI.1` appears under
 * `1.1.1.CS.1`, `CS.2`, and `CS.3` (28 of 79 indicators collide by code).
 * Keeping the subject-scoped unique key would collapse those distinct
 * indicators into one on ingest.
 *
 * Fix: scope uniqueness to (content_standard_id, code). The content standard
 * is the real disambiguator; the raw code is kept as-printed.
 */
export class SyllabusIndicatorUniqueByCS_2190000000000 implements MigrationInterface {
  name = 'SyllabusIndicatorUniqueByCS_2190000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE syllabus_indicators DROP CONSTRAINT IF EXISTS syllabus_indicators_uq`,
    );
    await queryRunner.query(
      `ALTER TABLE syllabus_indicators
         ADD CONSTRAINT syllabus_indicators_uq UNIQUE (content_standard_id, code)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE syllabus_indicators DROP CONSTRAINT IF EXISTS syllabus_indicators_uq`,
    );
    await queryRunner.query(
      `ALTER TABLE syllabus_indicators
         ADD CONSTRAINT syllabus_indicators_uq UNIQUE (subject_id, curriculum_version, code)`,
    );
  }
}
