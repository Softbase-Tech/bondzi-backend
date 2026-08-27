import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Knowledge Layer (premium plan Workstream A / remediation 0.9 + 0.9b).
 *
 * 1. `learning_material_chunks` — extracted MoE Learner-Material
 *    content: KEY IDEAS blocks, section introductions, worked
 *    EXAMPLE+SOLUTION pairs, and ACTIVITY prompts. This is the
 *    platform's authoritative FACT SOURCE: the syllabus defines what
 *    a student must master (scope); these chunks are what the student
 *    must actually read and know (content). Separate table from the
 *    syllabus hierarchy on purpose — different unit of data, different
 *    cardinality (one indicator → many chunks), different mutation
 *    lifecycle (chunks get OCR spot-fixes; the syllabus is stable),
 *    and only chunks are embedded for retrieval.
 *
 *    Join spine: (subject_id, form_level, strand_code, sub_strand_code)
 *    maps onto the NaCCA hierarchy; `syllabus_topic_id` is resolved at
 *    ingest time so student-facing remediation lookups are one join.
 *
 *    `embedding` mirrors syllabus_indicators (migration 2180): raw
 *    vector(1024) column + HNSW cosine index, deliberately NOT mapped
 *    in the TypeORM entity — pgvector values only move through raw
 *    parameterised SQL.
 *
 * 2. `syllabus_indicators.pedagogy_notes` + statement cleanup
 *    (remediation 0.9b/1.1a): NaCCA extraction glued pedagogy prose
 *    onto outcome statements ("Model and solve real life problems on
 *    sets. : Provide learners the opportunity to engage…"). That noise
 *    leaked into every prompt and is a large part of why generation
 *    drifted into paraphrasing syllabus prose. The cleanup splits on
 *    the first ' : ' delimiter, keeps the real statement, and stashes
 *    the removed pedagogy blob in `pedagogy_notes` — nothing is lost,
 *    and the migration is idempotent (rows with pedagogy_notes already
 *    set are skipped; a cleaned statement has no ' : ' left).
 *
 * 3. `subjects.ai_retrieval_mode` — the anchored-vs-strict deviation
 *    dial ('anchored' default: novel questions on grounded facts;
 *    'strict' reserved for hallucination-sensitive humanities).
 */
export class LearningMaterialChunks2270000000000 implements MigrationInterface {
  name = 'LearningMaterialChunks2270000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table if not exists "learning_material_chunks" (
        "id"               uuid primary key default gen_random_uuid(),
        "subject_id"       uuid not null references "subjects"("id") on delete restrict,
        "form_level"       int  not null,
        "strand_code"      text,
        "sub_strand_code"  text,
        "section_code"     text,
        "section_title"    text not null,
        "chunk_type"       text not null,
        "body_md"          text not null,
        "source_pdf"       text not null,
        "source_page"      int,
        "syllabus_topic_id" uuid references "syllabus_topics"("id") on delete set null,
        "embedding_model"  text,
        "embedded_at"      timestamptz,
        "created_at"       timestamptz not null default now(),
        "updated_at"       timestamptz not null default now(),
        constraint "chk_lm_chunk_type" check ("chunk_type" in
          ('key_ideas','introduction','example','activity','content'))
      );
    `);
    await queryRunner.query(`
      alter table "learning_material_chunks"
        add column if not exists embedding vector(1024);
    `);
    await queryRunner.query(`
      create index if not exists "idx_lm_chunks_scope"
        on "learning_material_chunks" ("subject_id", "form_level", "strand_code", "sub_strand_code");
    `);
    await queryRunner.query(`
      create index if not exists "idx_lm_chunks_topic"
        on "learning_material_chunks" ("syllabus_topic_id")
        where "syllabus_topic_id" is not null;
    `);
    await queryRunner.query(`
      create index if not exists "idx_lm_chunks_embedding"
        on "learning_material_chunks"
        using hnsw (embedding vector_cosine_ops);
    `);
    // Full-text fallback for retrieval QA / admin search.
    await queryRunner.query(`
      create index if not exists "idx_lm_chunks_tsv"
        on "learning_material_chunks"
        using gin (to_tsvector('english', coalesce("section_title",'') || ' ' || "body_md"));
    `);

    // --- 2. pedagogy cleanup ------------------------------------------------
    await queryRunner.query(`
      alter table "syllabus_indicators"
        add column if not exists "pedagogy_notes" text;
    `);
    // Idempotent: only rows still carrying the ' : ' delimiter and not
    // yet cleaned. The >= 15-char guard skips degenerate splits where
    // the "statement" half would be too short to stand alone.
    await queryRunner.query(`
      update "syllabus_indicators"
         set "pedagogy_notes" = substr("statement", position(' : ' in "statement") + 3),
             "statement"      = trim(split_part("statement", ' : ', 1))
       where "statement" like '% : %'
         and "pedagogy_notes" is null
         and length(trim(split_part("statement", ' : ', 1))) >= 15;
    `);
    // Same pollution exists on learning-outcome statements.
    await queryRunner.query(`
      alter table "syllabus_learning_outcomes"
        add column if not exists "pedagogy_notes" text;
    `);
    await queryRunner.query(`
      update "syllabus_learning_outcomes"
         set "pedagogy_notes" = substr("statement", position(' : ' in "statement") + 3),
             "statement"      = trim(split_part("statement", ' : ', 1))
       where "statement" like '% : %'
         and "pedagogy_notes" is null
         and length(trim(split_part("statement", ' : ', 1))) >= 15;
    `);

    // --- 3. anchored-vs-strict dial ----------------------------------------
    await queryRunner.query(`
      alter table "subjects"
        add column if not exists "ai_retrieval_mode" text not null default 'anchored';
    `);
    await queryRunner.query(`
      alter table "subjects"
        drop constraint if exists "chk_subjects_ai_retrieval_mode";
    `);
    await queryRunner.query(`
      alter table "subjects"
        add constraint "chk_subjects_ai_retrieval_mode"
        check ("ai_retrieval_mode" in ('anchored','strict'));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `alter table "subjects" drop constraint if exists "chk_subjects_ai_retrieval_mode";`,
    );
    await queryRunner.query(
      `alter table "subjects" drop column if exists "ai_retrieval_mode";`,
    );
    // Statement cleanup is not reversed (pedagogy_notes keeps the
    // removed text; a manual re-concat is possible but never desirable).
    await queryRunner.query(
      `drop table if exists "learning_material_chunks" cascade;`,
    );
  }
}
