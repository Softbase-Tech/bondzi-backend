import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { SyllabusTopic } from './entities/syllabus-topic.entity';

export interface TopicSyncResult {
  /** New topic rows inserted from CS on this run. */
  inserted: number;
  /** CS rows that couldn't insert because their title collided with an
   *  existing hand-authored topic. Logged for admin review; the CS
   *  simply stays unbridged until the admin renames the collision. */
  skippedForTitleCollision: number;
  /** pm_test_questions rows repointed to their now-existing topic in
   *  this run (previously had a NULL syllabus_topic_id). */
  questionsRepointed: number;
}

/**
 * Owns the one-way sync from `syllabus_content_standards` into
 * `syllabus_topics` — the flat model the mobile Level Test picker
 * reads. Deliberately outside `SyllabusIngestionService` per the
 * extraction brief §10 ("do not modify SyllabusIngestionService"):
 * this is additive plumbing, not an ingestion behavior change.
 *
 * Runs are always idempotent. INSERTs are guarded by both a partial
 * unique index on `source_content_standard_id` and the pre-existing
 * unique index on `(subject_id, exam_type, form_level, title)`. The
 * pm-test repoint step only touches rows currently NULL — never
 * overwrites an existing topic assignment.
 */
@Injectable()
export class SyllabusTopicSyncService {
  private readonly logger = new Logger(SyllabusTopicSyncService.name);

  constructor(
    @InjectRepository(SyllabusTopic)
    private readonly topics: Repository<SyllabusTopic>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Sync every CS into `syllabus_topics`. Safe to run any time — a
   * repeated run inserts nothing. Called after admin ingest / approve
   * flows, and available as a standalone endpoint for admins to
   * trigger manually if needed.
   *
   * Optional `subjectId` scope keeps the query cheap when a single
   * subject just re-ingested.
   */
  async syncAll(opts: { subjectId?: string } = {}): Promise<TopicSyncResult> {
    const filter = opts.subjectId ? `AND subj.id = $1::uuid` : '';
    const params: string[] = opts.subjectId ? [opts.subjectId] : [];

    // Backfill missing topics. Mirrors migration 2220… so re-running
    // it after new CS rows land converges the topic table.
    const insertResult: Array<{ n: number }> = await this.dataSource.query(
      `
      WITH ins AS (
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
        ${filter}
        ON CONFLICT DO NOTHING
        RETURNING id
      )
      SELECT count(*)::int AS n FROM ins
      `,
      params,
    );
    const inserted = insertResult[0]?.n ?? 0;

    // Count CS rows that we WANTED to insert but couldn't because of
    // the title collision — an admin already hand-authored a topic
    // with the same title. This isn't an error, but it's worth
    // surfacing so the admin knows which CS is unbridged.
    const collisionResult: Array<{ n: number }> = await this.dataSource.query(
      `
      SELECT count(*)::int AS n
      FROM syllabus_content_standards cs
      JOIN syllabus_sub_strands sub ON sub.id = cs.sub_strand_id
      JOIN syllabus_strands strand ON strand.id = sub.strand_id
      JOIN subjects subj ON subj.id = strand.subject_id
      WHERE NOT EXISTS (
        SELECT 1 FROM syllabus_topics t
        WHERE t.source_content_standard_id = cs.id
      )
      AND EXISTS (
        SELECT 1 FROM syllabus_topics t
        WHERE t.subject_id = subj.id
          AND t.exam_type  = subj.exam_type
          AND t.form_level = cs.year
          AND t.title      = cs.title
      )
      ${filter}
      `,
      params,
    );
    const skippedForTitleCollision = collisionResult[0]?.n ?? 0;

    // Repoint pm_test_questions.syllabus_topic_id for any question
    // still NULL but tagged with an indicator that now maps to a
    // topic. Never overwrites.
    const repointResult: Array<{ n: number }> = await this.dataSource.query(
      `
      WITH upd AS (
        UPDATE pm_test_questions q
        SET syllabus_topic_id = t.id
        FROM syllabus_indicators li
        JOIN syllabus_topics t
          ON t.source_content_standard_id = li.content_standard_id
        WHERE q.syllabus_indicator_id = li.id
          AND q.syllabus_topic_id IS NULL
        RETURNING q.id
      )
      SELECT count(*)::int AS n FROM upd
      `,
    );
    const questionsRepointed = repointResult[0]?.n ?? 0;

    if (inserted || questionsRepointed || skippedForTitleCollision) {
      this.logger.log(
        `[syllabus-topics] sync: +${inserted} topics, ${questionsRepointed} questions repointed, ${skippedForTitleCollision} title collisions${opts.subjectId ? ` (subject=${opts.subjectId})` : ''}`,
      );
    }

    return { inserted, skippedForTitleCollision, questionsRepointed };
  }
}
