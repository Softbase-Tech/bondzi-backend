import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Client-facing topic titles are display labels, not curriculum text.
 *
 * The topics bridge titles each synced topic with its content-standard
 * statement ("Demonstrate knowledge and understanding of ..."), which
 * reads as a teacher objective, not a picker label. Admins rename them
 * to student-friendly titles (usually the textbook section title, e.g.
 * "Nature and Functions of Accounting") — but the sync's refresh step
 * would revert any rename back to the CS statement on the next
 * re-ingest.
 *
 * `is_title_custom` marks a title as admin-owned: the sync refresh
 * keeps converging description/form/sort for such rows but leaves the
 * title alone. Set automatically when an admin renames a topic, and by
 * the retitle-from-materials pass.
 */
export class SyllabusTopicCustomTitle_2350000000000 implements MigrationInterface {
  name = 'SyllabusTopicCustomTitle_2350000000000';

  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(
      `ALTER TABLE syllabus_topics
         ADD COLUMN IF NOT EXISTS is_title_custom boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(qr: QueryRunner): Promise<void> {
    await qr.query(
      `ALTER TABLE syllabus_topics DROP COLUMN IF EXISTS is_title_custom`,
    );
  }
}
