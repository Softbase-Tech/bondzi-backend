import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a partial unique index on the active rows of `syllabus_topics`.
 * Without this a bulk-import that runs twice inserts duplicate rows,
 * which the PM-Test generation picker renders as two identical
 * options — confusing at best, silently unfair at worst (two picks
 * would double-weight one topic in generation).
 *
 * Partial (`where is_active = true`) so soft-deleting a row and then
 * re-inserting the same title later is legal — the soft-deleted row
 * doesn't collide.
 *
 * `syllabus_topics` is empty in production today (the CRUD lands
 * in this same phase), so the migration is safe to run without a
 * preflight dedup step.
 */
export class SyllabusTopicUniqueness_1990000000000 implements MigrationInterface {
  name = 'SyllabusTopicUniqueness_1990000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `create unique index if not exists "uq_syllabus_topics_active"
         on "syllabus_topics" ("subject_id", "exam_type", "form_level", "title")
         where "is_active" = true;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `drop index if exists "uq_syllabus_topics_active";`,
    );
  }
}
