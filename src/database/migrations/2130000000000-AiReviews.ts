import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * User-triggered AI Study Review feature.
 *
 *   - `ai_reviews`: one row per generated report. Doubles as the
 *     monthly quota ledger (count rows since month start). Reports are
 *     kept forever so the student can browse their history.
 *   - `ai_review_config`: single-row admin-editable monthly limits
 *     (Plus default 10, Pro default 30). Seeded with one row so the
 *     admin dashboard always has something to edit.
 *
 * This replaces the auto-generated daily weakness narrative as the
 * student-facing "AI insight" surface. The old `weakness_narratives`
 * table is left in place (the endpoint is deprecated, not dropped) so
 * nothing 404s mid-rollout.
 */
export class AiReviews_2130000000000 implements MigrationInterface {
  name = 'AiReviews_2130000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE ai_reviews (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subject_scope text NOT NULL DEFAULT 'all',
        content text NOT NULL,
        summary text NOT NULL,
        mode text NOT NULL DEFAULT 'personalised',
        model text NOT NULL,
        input_tokens int,
        output_tokens int,
        cost_usd numeric(12,6),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ai_reviews_mode_chk CHECK (mode IN ('bootstrap', 'personalised'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_ai_reviews_user_created
        ON ai_reviews (user_id, created_at DESC)
    `);

    await queryRunner.query(`
      CREATE TABLE ai_review_config (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        plus_monthly_limit int NOT NULL DEFAULT 10,
        pro_monthly_limit int NOT NULL DEFAULT 30,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Seed the single config row so the admin form has a row to edit
    // and the service can read limits without auto-provisioning.
    await queryRunner.query(`
      INSERT INTO ai_review_config (plus_monthly_limit, pro_monthly_limit)
      VALUES (10, 30)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS ai_review_config`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_ai_reviews_user_created`);
    await queryRunner.query(`DROP TABLE IF EXISTS ai_reviews`);
  }
}
