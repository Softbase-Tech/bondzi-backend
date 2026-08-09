import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Relax the `questions_section_check` CHECK constraint.
 *
 * The initial schema (1750000000000-InitialSchemaV2) defined:
 *     "section" varchar(4) check ("section" in ('A','B'))
 *
 * That assumed WASSCE Paper 1 only ever has Section A or B, which is
 * wrong for several real exam papers in our corpus. BECE English 1990
 * Paper 1 alone has Sections A (comprehension), B (opposites),
 * C (expression meanings), D (sentence completions) and E (synonyms).
 * Bulk-importing those past papers blows up with:
 *
 *     new row for relation "questions" violates check constraint
 *     "questions_section_check"
 *
 * Replace the static IN list with a regex that accepts any single
 * capital letter A–Z. That's still constrained enough to reject free-
 * form drift (no spaces, multi-letter codes, lowercase) while
 * supporting every section letter the WAEC/BECE structure actually
 * uses. NULL stays valid — questions without an explicit section
 * (PM Test, AI-generated) should not be force-tagged.
 */
export class WidenQuestionsSectionCheck_1850000000000 implements MigrationInterface {
  name = 'WidenQuestionsSectionCheck_1850000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table "questions"
        drop constraint if exists "questions_section_check";
    `);
    await queryRunner.query(`
      alter table "questions"
        add constraint "questions_section_check"
        check ("section" is null or "section" ~ '^[A-Z]$');
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the historical A/B-only constraint. NOTE: this will fail
    // if any rows have section letters outside A/B at the time of
    // rollback — that's intentional, since silently dropping data
    // would mask the problem.
    await queryRunner.query(`
      alter table "questions"
        drop constraint if exists "questions_section_check";
    `);
    await queryRunner.query(`
      alter table "questions"
        add constraint "questions_section_check"
        check ("section" in ('A','B'));
    `);
  }
}
