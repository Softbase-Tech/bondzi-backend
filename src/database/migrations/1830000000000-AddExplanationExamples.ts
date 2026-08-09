import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * questions.explanation_examples — JSONB array of worked examples that
 * supplement the existing free-text `explanation` paragraph.
 *
 * Why on the question row (not a separate table):
 *   - 1:1 with the question; never queried independently.
 *   - Typical count ≤ 3 per question. JSONB inline avoids a join on
 *     every read while keeping per-example fields queryable via the
 *     `->`/`->>` operators if a future admin search needs it.
 *
 * Schema of each element (enforced at the DTO layer, not the DB):
 *   {
 *     caption?: string,    // optional label, e.g. "Example 1"
 *     prompt: string,      // markdown — the example scenario
 *     solution: string,    // markdown — the worked-out answer
 *     steps?: string[],    // optional ordered bullets
 *     imageUrl?: string,   // optional diagram / figure attached to this example
 *   }
 *
 * Backward compatible: existing rows stay NULL → clients render only
 * the existing `explanation` paragraph, exactly as today.
 */
export class AddExplanationExamples_1830000000000 implements MigrationInterface {
  name = 'AddExplanationExamples_1830000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table "questions"
      add column if not exists "explanation_examples" jsonb;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `alter table "questions" drop column if exists "explanation_examples";`,
    );
  }
}
