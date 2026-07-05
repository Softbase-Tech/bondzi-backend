import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a dedicated `provider` column to `ai_usage_log` so the admin
 * AI monitor can group cost / calls / rejects by provider cleanly,
 * instead of deriving from the `model` string prefix on every query.
 *
 * Backfill: existing rows are all pre-Ollama, so `provider` defaults
 * to 'bedrock'. New writes fill it per-call from the effective
 * client (bedrock | ollama).
 *
 * Nullable + default 'bedrock' rather than NOT NULL so the migration
 * runs without touching every historic row synchronously — the
 * default handles the backfill in one metadata-only DDL operation.
 * Application code writes an explicit value going forward.
 */
export class AiUsageLogProvider_1980000000000 implements MigrationInterface {
  name = 'AiUsageLogProvider_1980000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `alter table "ai_usage_log"
         add column if not exists "provider" text not null default 'bedrock';`,
    );
    // "Show me Bedrock cost this week" and "show me Ollama call
    // volume yesterday" are both provider-first queries.
    await queryRunner.query(
      `create index if not exists "idx_ai_usage_provider_created"
         on "ai_usage_log" ("provider", "created_at");`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `drop index if exists "idx_ai_usage_provider_created";`,
    );
    await queryRunner.query(
      `alter table "ai_usage_log" drop column if exists "provider";`,
    );
  }
}
