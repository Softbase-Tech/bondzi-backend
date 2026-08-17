import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PART A / A1 — NaCCA standards-based curriculum hierarchy (knowledge spine).
 *
 *   Strand → Sub-strand → { Content Standard → Indicator → Assessment item }
 *                          + Learning Outcome
 *   + deduped pedagogy refs (boilerplate, never embedded)
 *
 * The Learning Indicator is the atomic unit; `subject_id` + `form_level`
 * are denormalised onto it for the hot retrieval path. Codes (e.g.
 * `1.1.1.LI.1`) are natural keys, unique per (subject, curriculum_version).
 *
 * Deliberately NO `embedding vector(N)` column and NO `CREATE EXTENSION
 * vector` here — the vector index is added in a later embeddings-phase
 * migration once pgvector availability is confirmed on the deployment.
 * These tables are a pure relational structure with zero infra risk.
 *
 * Replaces the shallow `syllabus_topics` (title/description) as the
 * curriculum surface; that table is deprecated and dropped in a later
 * cleanup migration once all consumers read indicators (see plan §A1b).
 */
export class SyllabusHierarchy_2160000000000 implements MigrationInterface {
  name = 'SyllabusHierarchy_2160000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE syllabus_strands (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        subject_id uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
        form_level int NOT NULL,
        code text NOT NULL,
        title text NOT NULL,
        curriculum_version text NOT NULL DEFAULT 'nacca-2024',
        sort_order int NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT syllabus_strands_uq UNIQUE (subject_id, form_level, curriculum_version, code)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_syllabus_strands_subject ON syllabus_strands (subject_id, form_level)`,
    );

    await queryRunner.query(`
      CREATE TABLE syllabus_sub_strands (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        strand_id uuid NOT NULL REFERENCES syllabus_strands(id) ON DELETE CASCADE,
        code text NOT NULL,
        title text NOT NULL,
        sort_order int NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT syllabus_sub_strands_uq UNIQUE (strand_id, code)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_syllabus_sub_strands_strand ON syllabus_sub_strands (strand_id)`,
    );

    await queryRunner.query(`
      CREATE TABLE syllabus_learning_outcomes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        sub_strand_id uuid NOT NULL REFERENCES syllabus_sub_strands(id) ON DELETE CASCADE,
        code text NOT NULL,
        statement text NOT NULL,
        sort_order int NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT syllabus_learning_outcomes_uq UNIQUE (sub_strand_id, code)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_syllabus_learning_outcomes_sub_strand ON syllabus_learning_outcomes (sub_strand_id)`,
    );

    await queryRunner.query(`
      CREATE TABLE syllabus_content_standards (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        sub_strand_id uuid NOT NULL REFERENCES syllabus_sub_strands(id) ON DELETE CASCADE,
        code text NOT NULL,
        statement text NOT NULL,
        sort_order int NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT syllabus_content_standards_uq UNIQUE (sub_strand_id, code)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_syllabus_content_standards_sub_strand ON syllabus_content_standards (sub_strand_id)`,
    );

    await queryRunner.query(`
      CREATE TABLE syllabus_indicators (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        content_standard_id uuid NOT NULL REFERENCES syllabus_content_standards(id) ON DELETE CASCADE,
        subject_id uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
        form_level int NOT NULL,
        code text NOT NULL,
        statement text NOT NULL,
        worked_content text,
        curriculum_version text NOT NULL DEFAULT 'nacca-2024',
        source_ref jsonb,
        status text NOT NULL DEFAULT 'draft',
        sort_order int NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT syllabus_indicators_uq UNIQUE (subject_id, curriculum_version, code),
        CONSTRAINT syllabus_indicators_status_chk CHECK (status IN ('draft', 'approved'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_syllabus_indicators_retrieval ON syllabus_indicators (subject_id, form_level, status)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_syllabus_indicators_content_standard ON syllabus_indicators (content_standard_id)`,
    );

    await queryRunner.query(`
      CREATE TABLE syllabus_assessment_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        indicator_id uuid NOT NULL REFERENCES syllabus_indicators(id) ON DELETE CASCADE,
        code text NOT NULL,
        dok_level int NOT NULL,
        question text NOT NULL,
        solution text,
        sort_order int NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT syllabus_assessment_items_dok_chk CHECK (dok_level BETWEEN 1 AND 4)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_syllabus_assessment_items_indicator ON syllabus_assessment_items (indicator_id)`,
    );

    await queryRunner.query(`
      CREATE TABLE syllabus_pedagogy_refs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        subject_id uuid REFERENCES subjects(id) ON DELETE CASCADE,
        scope text NOT NULL DEFAULT 'subject',
        competencies text,
        gesi_sel_values text,
        curriculum_version text NOT NULL DEFAULT 'nacca-2024',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT syllabus_pedagogy_refs_scope_chk CHECK (scope IN ('subject', 'global'))
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS syllabus_pedagogy_refs`);
    await queryRunner.query(`DROP TABLE IF EXISTS syllabus_assessment_items`);
    await queryRunner.query(`DROP TABLE IF EXISTS syllabus_indicators`);
    await queryRunner.query(`DROP TABLE IF EXISTS syllabus_content_standards`);
    await queryRunner.query(`DROP TABLE IF EXISTS syllabus_learning_outcomes`);
    await queryRunner.query(`DROP TABLE IF EXISTS syllabus_sub_strands`);
    await queryRunner.query(`DROP TABLE IF EXISTS syllabus_strands`);
  }
}
