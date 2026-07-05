import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Entitlement matrix — the single source of truth for tier × service
 * caps. Replaces the hardcoded `@RequiresSubscription()` gates and
 * hardcoded "20/day" style numbers scattered across controllers.
 *
 * Two tables:
 *
 *   tier_services
 *     Row per (account_type, service). Columns:
 *       - enabled       — off = 403 for that tier.
 *       - daily_cap     — NULL means unlimited (still tracked, not
 *                         enforced). 0 with enabled=true is a valid
 *                         "kill switch" state.
 *       - config        — jsonb for per-service flags. Today's uses:
 *                         { requiresFormLevel: true } on level_tests
 *                         (NOVDEC students have no formLevel and are
 *                         refused at the guard level for this service).
 *                         { model: 'ollama:<name>' } on services whose
 *                         model can flip at runtime without a deploy.
 *
 *   user_service_usage
 *     Row per (user_id, service, day). `day` is an Accra-wall-clock
 *     date so a student's day rolls over at midnight local time, not
 *     at UTC. Composite PK on (user_id, service, day) — the
 *     `@RequiresService` guard writes via ON CONFLICT / atomic
 *     increment so two concurrent requests can't both slip past the
 *     cap.
 *
 * Seed data (this migration):
 *   Free:    core PP unlimited · elective PP 10/day · level tests 20/day
 *            AI features disabled.
 *   Plus:    core + elective PP unlimited · AI explanations 20/day
 *            · level tests 80/day · AI weakness 1/day
 *            post-exam breakdown DISABLED (feature deferred).
 *   Pro:     everything unlimited (daily_cap = NULL) except
 *            post-exam breakdown, still DISABLED at the tier level.
 *
 * NOVDEC: NOT a tier. NOVDEC users pick their tier as Free/Plus/Pro
 * on the WASSCE pool. Their inability to use level_tests is enforced
 * via the `requiresFormLevel` config flag on the level_tests row —
 * NOVDEC users have `form_level = null` so the guard refuses without
 * needing a hardcoded exam-type list.
 */
export class EntitlementMatrix_1960000000000 implements MigrationInterface {
  name = 'EntitlementMatrix_1960000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enum for the service registry — mirrors EntitlementService in
    // src/common/types/enums.ts. Keep both in lock-step.
    await queryRunner.query(`
      do $$ begin
        if not exists (select 1 from pg_type where typname = 'entitlement_service_enum') then
          create type "entitlement_service_enum" as enum (
            'past_papers_core',
            'past_papers_elective',
            'level_tests',
            'mock_exams',
            'ai_explanations',
            'post_exam_ai_breakdown',
            'ai_weakness_narratives'
          );
        end if;
      end $$;
    `);

    await queryRunner.query(`
      create table if not exists "tier_services" (
        "id" uuid primary key default gen_random_uuid(),
        "account_type" "account_type_enum" not null,
        "service" "entitlement_service_enum" not null,
        "enabled" boolean not null default true,
        "daily_cap" integer,
        "config" jsonb not null default '{}'::jsonb,
        "updated_at" timestamptz not null default now(),
        "updated_by" uuid,
        constraint "uq_tier_services_account_service" unique ("account_type", "service"),
        constraint "chk_tier_services_daily_cap_nonneg"
          check ("daily_cap" is null or "daily_cap" >= 0)
      );
    `);
    await queryRunner.query(
      `create index if not exists "idx_tier_services_lookup"
         on "tier_services" ("account_type", "service");`,
    );

    await queryRunner.query(`
      create table if not exists "user_service_usage" (
        "user_id" uuid not null references "users"("id") on delete cascade,
        "service" "entitlement_service_enum" not null,
        "day" date not null,
        "used_count" integer not null default 0,
        "updated_at" timestamptz not null default now(),
        primary key ("user_id", "service", "day"),
        constraint "chk_user_service_usage_nonneg" check ("used_count" >= 0)
      );
    `);
    // Reverse index for the admin usage report ("who's near their cap
    // for service X today?"). Not needed by the guard's hot path (that
    // uses the composite PK).
    await queryRunner.query(
      `create index if not exists "idx_user_service_usage_service_day"
         on "user_service_usage" ("service", "day");`,
    );

    // ----- Seed the matrix -----
    // The seed is idempotent via `on conflict do nothing` so re-running
    // this migration on a partially-seeded db doesn't stamp over any
    // admin edits made after the initial seed landed.
    const rows: Array<{
      account: 'free' | 'plus' | 'pro';
      service:
        | 'past_papers_core'
        | 'past_papers_elective'
        | 'level_tests'
        | 'mock_exams'
        | 'ai_explanations'
        | 'post_exam_ai_breakdown'
        | 'ai_weakness_narratives';
      enabled: boolean;
      dailyCap: number | null;
      config: Record<string, unknown>;
    }> = [
      // ---------- FREE ----------
      {
        account: 'free',
        service: 'past_papers_core',
        enabled: true,
        dailyCap: null,
        config: {},
      },
      {
        account: 'free',
        service: 'past_papers_elective',
        enabled: true,
        dailyCap: 10,
        config: {},
      },
      {
        account: 'free',
        service: 'level_tests',
        enabled: true,
        dailyCap: 20,
        config: { requiresFormLevel: true },
      },
      {
        account: 'free',
        service: 'mock_exams',
        enabled: false,
        dailyCap: 0,
        config: {},
      },
      {
        account: 'free',
        service: 'ai_explanations',
        enabled: false,
        dailyCap: 0,
        config: {},
      },
      {
        account: 'free',
        service: 'post_exam_ai_breakdown',
        enabled: false,
        dailyCap: 0,
        config: {},
      },
      {
        account: 'free',
        service: 'ai_weakness_narratives',
        enabled: false,
        dailyCap: 0,
        config: {},
      },
      // ---------- PLUS ----------
      {
        account: 'plus',
        service: 'past_papers_core',
        enabled: true,
        dailyCap: null,
        config: {},
      },
      {
        account: 'plus',
        service: 'past_papers_elective',
        enabled: true,
        dailyCap: null,
        config: {},
      },
      {
        account: 'plus',
        service: 'level_tests',
        enabled: true,
        dailyCap: 80,
        config: { requiresFormLevel: true },
      },
      {
        account: 'plus',
        service: 'mock_exams',
        enabled: true,
        dailyCap: 5,
        config: {},
      },
      {
        account: 'plus',
        service: 'ai_explanations',
        enabled: true,
        dailyCap: 20,
        config: {},
      },
      // Post-exam AI breakdown feature is deferred (Phase 2 revisit).
      // Slot reserved so enabling later is one row update.
      {
        account: 'plus',
        service: 'post_exam_ai_breakdown',
        enabled: false,
        dailyCap: 3,
        config: {},
      },
      {
        account: 'plus',
        service: 'ai_weakness_narratives',
        enabled: true,
        dailyCap: 1,
        config: {},
      },
      // ---------- PRO ----------
      {
        account: 'pro',
        service: 'past_papers_core',
        enabled: true,
        dailyCap: null,
        config: {},
      },
      {
        account: 'pro',
        service: 'past_papers_elective',
        enabled: true,
        dailyCap: null,
        config: {},
      },
      {
        account: 'pro',
        service: 'level_tests',
        enabled: true,
        dailyCap: null,
        config: { requiresFormLevel: true },
      },
      {
        account: 'pro',
        service: 'mock_exams',
        enabled: true,
        dailyCap: null,
        config: {},
      },
      {
        account: 'pro',
        service: 'ai_explanations',
        enabled: true,
        dailyCap: null,
        config: {},
      },
      {
        account: 'pro',
        service: 'post_exam_ai_breakdown',
        enabled: false,
        dailyCap: null,
        config: {},
      },
      {
        account: 'pro',
        service: 'ai_weakness_narratives',
        enabled: true,
        dailyCap: null,
        config: {},
      },
    ];

    for (const r of rows) {
      await queryRunner.query(
        `insert into "tier_services"
           ("account_type", "service", "enabled", "daily_cap", "config")
         values ($1, $2, $3, $4, $5::jsonb)
         on conflict ("account_type", "service") do nothing;`,
        [r.account, r.service, r.enabled, r.dailyCap, JSON.stringify(r.config)],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `drop table if exists "user_service_usage" cascade;`,
    );
    await queryRunner.query(`drop table if exists "tier_services" cascade;`);
    await queryRunner.query(`drop type if exists "entitlement_service_enum";`);
  }
}
