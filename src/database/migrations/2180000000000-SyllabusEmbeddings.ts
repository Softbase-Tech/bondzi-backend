import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PART A / A5 — pgvector embedding column for syllabus indicators.
 *
 * This is the FIRST migration in the codebase to require the `vector`
 * extension. It was validated on the server beforehand (pgvector 0.8.6,
 * `CREATE EXTENSION` succeeds); `IF NOT EXISTS` makes re-runs a no-op.
 *
 * The vector width (1024) MUST match `AI_EMBEDDING_DIM` and the embedding
 * model (Titan v2 / bge-m3 = 1024). Switching to a model with a different
 * dimension means re-embedding AND altering this column width — hence
 * `embedding_model` is stored per row so a mismatch is detectable.
 *
 * The `embedding` column is intentionally NOT mapped on the TypeORM entity
 * (TypeORM has no `vector` type); it is written/read via raw SQL using
 * pgvector operators (`<=>` cosine distance). HNSW index for fast ANN
 * search; building it on an empty column is instant.
 */
export class SyllabusEmbeddings_2180000000000 implements MigrationInterface {
  name = 'SyllabusEmbeddings_2180000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    await queryRunner.query(`
      ALTER TABLE syllabus_indicators
        ADD COLUMN embedding vector(1024),
        ADD COLUMN embedding_model text,
        ADD COLUMN embedded_at timestamptz
    `);

    await queryRunner.query(`
      CREATE INDEX idx_syllabus_indicators_embedding
        ON syllabus_indicators
        USING hnsw (embedding vector_cosine_ops)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_syllabus_indicators_embedding`,
    );
    await queryRunner.query(`
      ALTER TABLE syllabus_indicators
        DROP COLUMN IF EXISTS embedded_at,
        DROP COLUMN IF EXISTS embedding_model,
        DROP COLUMN IF EXISTS embedding
    `);
    // Extension left in place — other objects may come to depend on it,
    // and dropping it is not part of reversing this table change.
  }
}
