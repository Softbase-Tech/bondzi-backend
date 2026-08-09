import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `ai_breakdown` + `ai_breakdown_generated_at` + `ai_breakdown_model`
 * columns to `exams` for the post-exam AI breakdown feature.
 *
 * Currently DORMANT — the POST_EXAM_AI_BREAKDOWN entitlement is disabled
 * on every tier per the Phase 0.1 seed (see migration 1960). Admin flips
 * a tier to enabled=true when the product decision lands; the endpoint
 * and storage are in place so no code change is needed at that point.
 *
 * Nullable + no default because most rows never receive a breakdown
 * (the feature is opt-in per exam once enabled). Text (not jsonb): the
 * breakdown is human-readable prose, not a structured payload.
 */
export class ExamsAiBreakdown_2010000000000 implements MigrationInterface {
  name = 'ExamsAiBreakdown_2010000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `alter table "exams"
         add column if not exists "ai_breakdown" text,
         add column if not exists "ai_breakdown_generated_at" timestamptz,
         add column if not exists "ai_breakdown_model" text;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `alter table "exams"
         drop column if exists "ai_breakdown",
         drop column if exists "ai_breakdown_generated_at",
         drop column if exists "ai_breakdown_model";`,
    );
  }
}
