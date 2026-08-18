import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bridge the NaCCA syllabus hierarchy (strands / sub-strands /
 * content-standards / learning-indicators) into the flat
 * `syllabus_topics` table that the mobile Level Test picker actually
 * reads.
 *
 * Before this migration:
 *   - Syllabus ingestion filled `syllabus_content_standards` +
 *     `syllabus_indicators` correctly per the extraction brief.
 *   - `syllabus_topics` was CRUD-only and empty for every subject
 *     nobody had hand-typed — Chemistry Form 3 included.
 *   - `pm_test_questions` carried `syllabus_indicator_id` but never
 *     `syllabus_topic_id`, so even the pm-test session builder (which
 *     filters `WHERE syllabus_topic_id IN (...)`) couldn't surface
 *     topic-scoped questions.
 *
 * This migration is INSERT-only. It never overwrites hand-authored
 * topics — the unique index on (subject_id, exam_type, form_level,
 * title) enforces that on the write. It never deletes anything —
 * `user_topic_mastery.syllabus_topic_id ON DELETE CASCADE` means a
 * dropped topic wipes mastery rows, so we skip DELETE entirely. And
 * the pm-test repoint step only writes rows whose `topic_id` is
 * currently NULL, so any legacy topic mapping (there aren't any today,
 * but future-proofing) is preserved.
 *
 * Chosen granularity is one CS = one topic. Coarser than LI (better
 * picker UX; ~8–15 topics per subject/form vs 40+) and each CS owns
 * multiple LI whose text becomes the topic description. LI-level
 * weakness tracking is untouched — the weakness signals table keys on
 * `syllabus_indicator_id`, not topic_id, so the finer signal survives.
 */
export class SyllabusTopicsBridge_2220000000000 implements MigrationInterface {
  public async up(qr: QueryRunner): Promise<void> {
    // 1) Add the source-of-truth pointer + a partial unique index so
    //    the CS→topic mapping is 1:1 and re-running the backfill is a
    //    no-op. Nullable so admin-authored rows (no CS source) coexist.
    await qr.query(`
      ALTER TABLE syllabus_topics
        ADD COLUMN IF NOT EXISTS source_content_standard_id uuid NULL
        REFERENCES syllabus_content_standards(id) ON DELETE SET NULL
    `);

    await qr.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_syllabus_topics_source_cs
        ON syllabus_topics (source_content_standard_id)
        WHERE source_content_standard_id IS NOT NULL
    `);

    // 2) Backfill: one topic per CS. Title is CS.title (the free-form
    //    English statement, not the "1.1.1.CS.1" code). Description is
    //    the LI text joined in sort order — that's what the reviewer
    //    sees when they tap a topic to preview. form_level comes from
    //    CS.year (per the brief §5, the first digit of the code IS the
    //    year). exam_type + subject via the sub_strand → strand →
    //    subject chain.
    //
    //    ON CONFLICT on the (subject_id, exam_type, form_level, title)
    //    unique index — if an admin already hand-typed a row with the
    //    same title, we leave it alone. Their row stays authoritative
    //    and the CS keeps a NULL bridge; the admin can attach it later
    //    if they want, but nothing breaks in the meantime.
    await qr.query(`
      INSERT INTO syllabus_topics
        (subject_id, exam_type, form_level, title, description,
         sort_order, is_active, source_content_standard_id)
      SELECT
        subj.id,
        subj.exam_type,
        cs.year,
        cs.title,
        (
          SELECT string_agg(li.learning_indicator, E'\n\n' ORDER BY li.sort_order)
          FROM syllabus_indicators li
          WHERE li.content_standard_id = cs.id
        ),
        cs.sort_order,
        true,
        cs.id
      FROM syllabus_content_standards cs
      JOIN syllabus_sub_strands sub ON sub.id = cs.sub_strand_id
      JOIN syllabus_strands strand ON strand.id = sub.strand_id
      JOIN subjects subj ON subj.id = strand.subject_id
      WHERE NOT EXISTS (
        SELECT 1 FROM syllabus_topics t
        WHERE t.source_content_standard_id = cs.id
      )
      ON CONFLICT DO NOTHING
    `);

    // 3) Repoint pm_test_questions.syllabus_topic_id via the indicator
    //    it was tagged with at generation time. Only touches rows
    //    whose topic_id is currently NULL, so any legacy assignment is
    //    preserved. Questions without a syllabus_indicator_id (rare,
    //    but possible on early rows) are left NULL — no data loss,
    //    just no topic-scoped visibility for those specific rows.
    await qr.query(`
      UPDATE pm_test_questions q
      SET syllabus_topic_id = t.id
      FROM syllabus_indicators li
      JOIN syllabus_topics t
        ON t.source_content_standard_id = li.content_standard_id
      WHERE q.syllabus_indicator_id = li.id
        AND q.syllabus_topic_id IS NULL
    `);
  }

  public async down(qr: QueryRunner): Promise<void> {
    // Only touch the rows this migration authored. Anything an admin
    // hand-typed (source_content_standard_id IS NULL) is left alone.
    // The pm_test_questions.syllabus_topic_id FK is ON DELETE SET NULL
    // so the delete cascades cleanly on that column. `user_topic_mastery`
    // rows on the deleted topics *would* cascade-delete — that's why
    // this down migration is safe to run only in dev / early rollback,
    // before real mastery data has accumulated against CS-sourced topics.
    await qr.query(`
      DELETE FROM syllabus_topics
      WHERE source_content_standard_id IS NOT NULL
    `);

    await qr.query(`DROP INDEX IF EXISTS ux_syllabus_topics_source_cs`);

    await qr.query(`
      ALTER TABLE syllabus_topics
        DROP COLUMN IF EXISTS source_content_standard_id
    `);
  }
}
