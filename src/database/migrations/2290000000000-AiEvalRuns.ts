import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Golden-set evaluation harness storage (premium plan §7.3 /
 * remediation 2.1). One row per nightly eval run; `metrics` carries
 * the probe results (key-agreement rate, explanation-contract pass
 * rate + reject-reason histogram, LLM-judge scores) so prompt changes
 * gate on measured deltas instead of vibes. Never pruned — the whole
 * point is the trend line.
 */
export class AiEvalRuns2290000000000 implements MigrationInterface {
  name = 'AiEvalRuns2290000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table if not exists "ai_eval_runs" (
        "id"          uuid primary key default gen_random_uuid(),
        "run_date"    date not null,
        "sample_size" int  not null,
        "metrics"     jsonb not null,
        "cost_usd"    numeric(12, 6) not null default 0,
        "created_at"  timestamptz not null default now()
      );
    `);
    await queryRunner.query(`
      create index if not exists "idx_ai_eval_runs_date"
        on "ai_eval_runs" ("run_date" desc);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists "ai_eval_runs";`);
  }
}
