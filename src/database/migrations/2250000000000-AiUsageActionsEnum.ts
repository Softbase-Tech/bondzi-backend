import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Restores AI cost telemetry for every student-facing feature.
 *
 * The Postgres enum `ai_usage_log_action_enum` was created by
 * InitialSchemaV2 with only five values ('explanation','hint',
 * 'chat_tutor','question_gen','moderation'). The TypeScript AiAction
 * enum has since grown ('weakness_narrative','post_exam_breakdown',
 * 'ai_review','embedding','syllabus_extraction', now 'answer_verify')
 * with NO matching ALTER TYPE — so with synchronize:false every
 * ai_usage_log insert for those actions threw 22P02 and was silently
 * swallowed by AiService.logUsage's try/catch. Consequence: zero
 * cost/latency/token telemetry for weakness narratives, AI reviews,
 * post-exam breakdowns and all embeddings, and the admin AI monitor
 * under-reported real spend.
 *
 * Postgres note: `ADD VALUE IF NOT EXISTS` is legal inside a
 * transaction (Postgres 12+); the 55P04 restriction only forbids
 * USING the new value in the same transaction — which this migration
 * never does. Same pattern as 1900-PaymentsAndBillingLog.
 */
export class AiUsageActionsEnum2250000000000 implements MigrationInterface {
  name = 'AiUsageActionsEnum2250000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const values = [
      'weakness_narrative',
      'post_exam_breakdown',
      'ai_review',
      'embedding',
      'syllabus_extraction',
      'answer_verify',
    ];
    for (const v of values) {
      await queryRunner.query(
        `ALTER TYPE "ai_usage_log_action_enum" ADD VALUE IF NOT EXISTS '${v}'`,
      );
    }
  }

  public async down(): Promise<void> {
    // Postgres cannot remove enum values. Rows written with the new
    // values would block a naive type-rebuild; the added values are
    // harmless to leave in place, so down() is a deliberate no-op.
  }
}
