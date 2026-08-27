import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Structured, machine-readable recommendations for the student-facing
 * AI features (premium plan §6.3–6.5). The narrative prose stays in
 * its existing columns; the `recommendations` jsonb carries the
 * tappable actions the app renders as deep links:
 *
 *   [{ "syllabusTopicId": "...", "action": "read",
 *      "chunkId": "...", "label": "Vectors — Key Ideas (p. 41)" },
 *    { "syllabusTopicId": "...", "action": "practice", "count": 5 }]
 *
 * Also `ai_reviews.signal_fingerprint` — the idempotency key: a POST
 * whose current signal hash matches the latest review returns that
 * review instead of regenerating a near-identical 1,200-token report
 * at full cost (premium plan §6.4).
 */
export class StudentFacingRecommendations2280000000000 implements MigrationInterface {
  name = 'StudentFacingRecommendations2280000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table "weakness_narratives"
        add column if not exists "recommendations" jsonb;
    `);
    await queryRunner.query(`
      alter table "exams"
        add column if not exists "ai_breakdown_recommendations" jsonb;
    `);
    await queryRunner.query(`
      alter table "ai_reviews"
        add column if not exists "signal_fingerprint" text;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `alter table "weakness_narratives" drop column if exists "recommendations";`,
    );
    await queryRunner.query(
      `alter table "exams" drop column if exists "ai_breakdown_recommendations";`,
    );
    await queryRunner.query(
      `alter table "ai_reviews" drop column if exists "signal_fingerprint";`,
    );
  }
}
