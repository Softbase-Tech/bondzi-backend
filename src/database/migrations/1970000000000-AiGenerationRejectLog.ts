import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reject log for AI generation.
 *
 * Two tables:
 *
 *   ai_generation_reject_log  — raw. One row per validation failure.
 *     Holds the model's actual output so the operator can inspect
 *     what went wrong and (if needed) rewrite the prompt. Bounded
 *     by a 30-day retention job so raw blobs don't grow forever.
 *
 *   ai_generation_reject_agg  — rolled up. Weekly-per-reason-per-model
 *     counter that outlives the raw retention window. Powers the
 *     "why is Ollama rejecting more than Bedrock this week?"
 *     admin dashboard AND survives after the raw blobs age out, so
 *     failure trends stay visible indefinitely.
 *
 * Rollup semantics: writes to `agg` are atomic UPSERTs incrementing
 * `count` for the (week_start, reason, provider, model) bucket. Week
 * boundary is Monday 00:00 UTC — matches the leaderboard week
 * convention. Aggregate rows never delete on their own; only the
 * raw log does.
 *
 * Enums are kept as plain text (not Postgres enums) so adding a new
 * reason later is a code change, not a migration.
 */
export class AiGenerationRejectLog_1970000000000 implements MigrationInterface {
  name = 'AiGenerationRejectLog_1970000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table if not exists "ai_generation_reject_log" (
        "id" uuid primary key default gen_random_uuid(),
        "job_id" uuid,
        "action" text not null,
        "provider" text not null,
        "model" text not null,
        "reason" text not null,
        "detail" text,
        "raw_output" text,
        "created_at" timestamptz not null default now()
      );
    `);
    // Retention filter runs on created_at; keep an index for it.
    await queryRunner.query(
      `create index if not exists "idx_reject_log_created_at"
         on "ai_generation_reject_log" ("created_at");`,
    );
    // "Show me every reject for reason=multiple_correct on model X" —
    // the primary admin query. Index the two dimensions people filter by.
    await queryRunner.query(
      `create index if not exists "idx_reject_log_reason_model"
         on "ai_generation_reject_log" ("reason", "model");`,
    );

    await queryRunner.query(`
      create table if not exists "ai_generation_reject_agg" (
        "week_start" date not null,
        "reason" text not null,
        "provider" text not null,
        "model" text not null,
        "count" integer not null default 0,
        "updated_at" timestamptz not null default now(),
        primary key ("week_start", "reason", "provider", "model"),
        constraint "chk_reject_agg_count_nonneg" check ("count" >= 0)
      );
    `);
    // Trend queries: "per-week counts for reason X across models" — the
    // reason-first index serves that.
    await queryRunner.query(
      `create index if not exists "idx_reject_agg_reason_week"
         on "ai_generation_reject_agg" ("reason", "week_start");`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `drop table if exists "ai_generation_reject_agg" cascade;`,
    );
    await queryRunner.query(
      `drop table if exists "ai_generation_reject_log" cascade;`,
    );
  }
}
