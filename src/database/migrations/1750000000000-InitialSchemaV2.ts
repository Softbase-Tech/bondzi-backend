import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bondzi v2 initial schema.
 *
 * This is the single source of truth for the entire database layout. It
 * supersedes any previous schema files. Creates every native PG enum, every
 * table, every index, seeds the admin-configurable rate/redemption/ad config
 * rows, and enables Row-Level Security on user-owned tables.
 *
 *   Dual exam platform:    BECE (JHS) + WASSCE (SHS)
 *   Free core product:     past papers, streaks, XP, leaderboard, SRS
 *   Pro unlocks:           inline AI explanations, Bondzi Test, ad-free
 *   Single-device login:   device_sessions (one row per user)
 *   XP economy:            admin-configurable earn rates + redemption tiers
 *   Referrals:             two-step XP reward (signup + qualification)
 */
export class InitialSchemaV2_1750000000000 implements MigrationInterface {
  name = 'InitialSchemaV2_1750000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`create extension if not exists "pgcrypto";`);
    await queryRunner.query(`create extension if not exists "pg_trgm";`);

    // -----------------------------------------------------------------------
    // Enums
    // -----------------------------------------------------------------------
    await queryRunner.query(
      `create type "users_role_enum" as enum ('student','teacher','admin','superadmin');`,
    );
    await queryRunner.query(
      `create type "users_auth_provider_enum" as enum ('email','google','phone');`,
    );
    await queryRunner.query(
      `create type "exam_type_enum" as enum ('bece','wassce');`,
    );
    await queryRunner.query(
      `create type "school_level_enum" as enum ('jhs','shs');`,
    );
    await queryRunner.query(
      `create type "subjects_category_enum" as enum ('core','elective','vocational');`,
    );
    await queryRunner.query(
      `create type "questions_question_type_enum" as enum ('mcq','true_false','fill_blank','essay','structured');`,
    );
    await queryRunner.query(
      `create type "questions_source_enum" as enum ('wassce_past','bece_past','ai_passmaster_test');`,
    );
    await queryRunner.query(
      `create type "questions_difficulty_enum" as enum ('easy','medium','hard');`,
    );
    await queryRunner.query(
      `create type "question_status_enum" as enum ('active','inactive','pending_review','archived');`,
    );
    await queryRunner.query(
      `create type "question_pool_enum" as enum ('past_paper','pm_test');`,
    );
    await queryRunner.query(
      `create type "exams_mode_enum" as enum ('past_paper','practice','topic_drill','pm_test','srs_review');`,
    );
    await queryRunner.query(
      `create type "exams_status_enum" as enum ('in_progress','completed','abandoned','paused');`,
    );
    await queryRunner.query(
      `create type "subscriptions_plan_enum" as enum ('free','monthly','termly','annual','xp_credit');`,
    );
    await queryRunner.query(
      `create type "subscriptions_status_enum" as enum ('active','expired','cancelled','trial','past_due','xp_credited');`,
    );
    await queryRunner.query(
      `create type "notifications_channel_enum" as enum ('push','sms','whatsapp','in_app');`,
    );
    await queryRunner.query(
      `create type "school_members_role_enum" as enum ('student','teacher','admin');`,
    );
    await queryRunner.query(
      `create type "ai_usage_log_action_enum" as enum ('explanation','hint','chat_tutor','question_gen','moderation');`,
    );
    await queryRunner.query(
      `create type "ai_job_type_enum" as enum ('explanation_bulk','pm_test_generation');`,
    );
    await queryRunner.query(
      `create type "ai_job_status_enum" as enum ('pending','running','completed','failed','cancelled');`,
    );
    await queryRunner.query(
      `create type "leaderboard_period_type_enum" as enum ('weekly','monthly');`,
    );

    // -----------------------------------------------------------------------
    // Core: users + schools
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      create table "users" (
        "id" uuid primary key default gen_random_uuid(),
        "full_name" text not null,
        "email" text unique,
        "phone" text unique,
        "password_hash" text,
        "auth_provider" "users_auth_provider_enum" not null default 'email',
        "role" "users_role_enum" not null default 'student',

        "exam_type" "exam_type_enum" not null,
        "school_level" "school_level_enum" not null,
        "form_level" int not null check ("form_level" between 1 and 3),

        "school_name" text,
        "region" text,
        "avatar_url" text,
        "is_active" boolean not null default true,

        "referral_code" text not null unique,
        "referred_by" uuid references "users"("id") on delete set null,
        "referral_qualified" boolean not null default false,

        "level_xp" bigint not null default 0,
        "spendable_xp" bigint not null default 0,
        "current_level" int not null default 1,

        "streak_days" int not null default 0,
        "longest_streak" int not null default 0,
        "last_study_date" date,

        "current_device_id" text,
        "country_code" varchar(2) not null default 'GH',
        "last_active_at" timestamptz,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz
      );
    `);
    await queryRunner.query(
      `create index "users_email_idx"        on "users" ("email");`,
    );
    await queryRunner.query(
      `create index "users_phone_idx"        on "users" ("phone");`,
    );
    await queryRunner.query(
      `create index "idx_users_exam_type"    on "users" ("exam_type");`,
    );
    await queryRunner.query(
      `create index "idx_users_referral"     on "users" ("referral_code");`,
    );
    await queryRunner.query(
      `create index "idx_users_referred_by"  on "users" ("referred_by");`,
    );
    await queryRunner.query(
      `create index "idx_users_active"       on "users" ("is_active","deleted_at");`,
    );

    await queryRunner.query(`
      create table "schools" (
        "id" uuid primary key default gen_random_uuid(),
        "name" text not null,
        "region" text,
        "contact_email" text,
        "licence_key" text unique,
        "student_cap" int not null default 200,
        "country_code" varchar(2) not null default 'GH',
        "licence_expires_at" timestamptz,
        "created_at" timestamptz not null default now()
      );
    `);
    await queryRunner.query(`
      create table "school_members" (
        "id" uuid primary key default gen_random_uuid(),
        "school_id" uuid not null references "schools"("id") on delete cascade,
        "user_id" uuid not null references "users"("id") on delete cascade,
        "role" "school_members_role_enum" not null default 'student',
        "joined_at" timestamptz not null default now(),
        constraint "school_member_uq" unique ("school_id","user_id")
      );
    `);
    await queryRunner.query(
      `create index "school_member_school_idx" on "school_members" ("school_id");`,
    );

    // -----------------------------------------------------------------------
    // Auth: device sessions (single-device enforcement)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      create table "device_sessions" (
        "id" uuid primary key default gen_random_uuid(),
        "user_id" uuid not null references "users"("id") on delete cascade,
        "device_id" text not null,
        "device_name" text,
        "refresh_token_jti" text not null unique,
        "ip_address" text,
        "created_at" timestamptz not null default now(),
        "last_seen_at" timestamptz not null default now()
      );
    `);
    await queryRunner.query(
      `create unique index "idx_device_sessions_user" on "device_sessions" ("user_id");`,
    );

    // -----------------------------------------------------------------------
    // Exam platform: subjects, topics, syllabus_topics
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      create table "subjects" (
        "id" uuid primary key default gen_random_uuid(),
        "code" text not null unique,
        "name" text not null,
        "exam_type" "exam_type_enum" not null,
        "category" "subjects_category_enum" not null default 'core',
        "is_core" boolean not null default false,
        "is_active" boolean not null default true,
        "sort_order" int not null default 0,
        "created_at" timestamptz not null default now()
      );
    `);
    await queryRunner.query(
      `create index "idx_subjects_exam_type" on "subjects" ("exam_type","is_active");`,
    );

    await queryRunner.query(`
      create table "topics" (
        "id" uuid primary key default gen_random_uuid(),
        "subject_id" uuid not null references "subjects"("id") on delete cascade,
        "title" text not null,
        "description" text,
        "sort_order" int not null default 0,
        "created_at" timestamptz not null default now(),
        constraint "topics_subject_title_uq" unique ("subject_id","title")
      );
    `);
    await queryRunner.query(
      `create index "topics_subject_idx" on "topics" ("subject_id");`,
    );

    await queryRunner.query(`
      create table "syllabus_topics" (
        "id" uuid primary key default gen_random_uuid(),
        "subject_id" uuid not null references "subjects"("id") on delete cascade,
        "exam_type" "exam_type_enum" not null,
        "form_level" int not null check ("form_level" between 1 and 3),
        "title" text not null,
        "description" text,
        "is_active" boolean not null default true,
        "sort_order" int not null default 0,
        "created_at" timestamptz not null default now()
      );
    `);
    await queryRunner.query(
      `create index "idx_syllabus_topics_subject_level" on "syllabus_topics" ("subject_id","form_level","exam_type");`,
    );

    // -----------------------------------------------------------------------
    // Question bank: questions, options, pm_test_*
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      create table "questions" (
        "id" uuid primary key default gen_random_uuid(),
        "subject_id" uuid not null references "subjects"("id") on delete restrict,
        "topic_id" uuid references "topics"("id") on delete set null,
        "exam_type" "exam_type_enum" not null,
        "question_type" "questions_question_type_enum" not null default 'mcq',
        "source" "questions_source_enum" not null default 'wassce_past',
        "body" text not null,
        "body_html" text,
        "image_url" text,
        "year" int,
        "wassce_paper" int check ("wassce_paper" in (1,2)),
        "section" varchar(4) check ("section" in ('A','B')),
        "difficulty" "questions_difficulty_enum" not null default 'medium',
        "irt_difficulty" float,
        "tags" text[] not null default ARRAY[]::text[],
        "explanation" text,
        "explanation_html" text,
        "explanation_model" text,
        "explanation_generated_at" timestamptz,
        "status" "question_status_enum" not null default 'active',
        "is_verified" boolean not null default false,
        "flag_count" int not null default 0,
        "times_answered" int not null default 0,
        "times_correct" int not null default 0,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now()
      );
    `);
    await queryRunner.query(
      `create index "questions_subject_idx"     on "questions" ("subject_id");`,
    );
    await queryRunner.query(
      `create index "questions_topic_idx"       on "questions" ("topic_id");`,
    );
    await queryRunner.query(
      `create index "questions_year_idx"        on "questions" ("year");`,
    );
    await queryRunner.query(
      `create index "questions_difficulty_idx"  on "questions" ("difficulty");`,
    );
    await queryRunner.query(
      `create index "idx_questions_exam_type"   on "questions" ("exam_type","status");`,
    );
    await queryRunner.query(
      `create index "idx_questions_subject_year"on "questions" ("subject_id","year");`,
    );
    await queryRunner.query(
      `create index "idx_questions_no_expl"     on "questions" ("exam_type","subject_id") where "explanation" is null;`,
    );
    await queryRunner.query(
      `create index "idx_questions_fts"         on "questions" using gin (to_tsvector('english', coalesce("body",'')));`,
    );

    await queryRunner.query(`
      create table "options" (
        "id" uuid primary key default gen_random_uuid(),
        "question_id" uuid not null references "questions"("id") on delete cascade,
        "label" varchar(2) not null,
        "body" text not null,
        "body_html" text,
        "image_url" text,
        "is_correct" boolean not null default false,
        "sort_order" int not null default 0
      );
    `);
    await queryRunner.query(
      `create index "idx_options_question" on "options" ("question_id");`,
    );

    await queryRunner.query(`
      create table "pm_test_questions" (
        "id" uuid primary key default gen_random_uuid(),
        "subject_id" uuid not null references "subjects"("id") on delete restrict,
        "syllabus_topic_id" uuid references "syllabus_topics"("id") on delete set null,
        "exam_type" "exam_type_enum" not null,
        "form_level" int not null check ("form_level" between 1 and 3),
        "question_type" "questions_question_type_enum" not null default 'mcq',
        "body" text not null,
        "explanation" text,
        "difficulty" "questions_difficulty_enum" not null default 'medium',
        "status" "question_status_enum" not null default 'pending_review',
        "generation_batch_id" uuid,
        "times_answered" int not null default 0,
        "times_correct" int not null default 0,
        "created_at" timestamptz not null default now()
      );
    `);
    await queryRunner.query(
      `create index "idx_pm_test_q_level"  on "pm_test_questions" ("exam_type","form_level","subject_id","status");`,
    );
    await queryRunner.query(
      `create index "idx_pm_test_q_review" on "pm_test_questions" ("status") where "status" = 'pending_review';`,
    );

    await queryRunner.query(`
      create table "pm_test_options" (
        "id" uuid primary key default gen_random_uuid(),
        "question_id" uuid not null references "pm_test_questions"("id") on delete cascade,
        "label" text not null,
        "body" text not null,
        "is_correct" boolean not null default false
      );
    `);
    await queryRunner.query(
      `create index "idx_pm_test_options_question" on "pm_test_options" ("question_id");`,
    );

    // -----------------------------------------------------------------------
    // Exam sessions + answers + SRS
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      create table "exams" (
        "id" uuid primary key default gen_random_uuid(),
        "user_id" uuid not null references "users"("id") on delete cascade,
        "exam_type" "exam_type_enum" not null,
        "mode" "exams_mode_enum" not null,
        "question_pool" "question_pool_enum" not null default 'past_paper',
        "status" "exams_status_enum" not null default 'in_progress',
        "subject_filter" jsonb,
        "question_ids" uuid[] not null default ARRAY[]::uuid[],
        "duration_seconds" int,
        "score" int,
        "total_questions" int,
        "percent_score" numeric(5,2),
        "xp_earned" int not null default 0,
        "started_at" timestamptz not null default now(),
        "completed_at" timestamptz,
        "created_at" timestamptz not null default now()
      );
    `);
    await queryRunner.query(
      `create index "idx_exams_user"          on "exams" ("user_id","status");`,
    );
    await queryRunner.query(
      `create index "idx_exams_type"          on "exams" ("exam_type","created_at");`,
    );

    await queryRunner.query(`
      create table "exam_answers" (
        "id" uuid primary key default gen_random_uuid(),
        "exam_id" uuid not null references "exams"("id") on delete cascade,
        "question_id" uuid not null references "questions"("id") on delete restrict,
        "question_pool" "question_pool_enum" not null default 'past_paper',
        "selected_option_id" uuid references "options"("id") on delete set null,
        "typed_answer" text,
        "is_correct" boolean,
        "time_spent_ms" int,
        "explanation_viewed" boolean not null default false,
        "answered_at" timestamptz not null default now(),
        constraint "exam_answers_exam_question_uq" unique ("exam_id","question_id")
      );
    `);
    await queryRunner.query(
      `create index "exam_answers_exam_idx"     on "exam_answers" ("exam_id");`,
    );
    await queryRunner.query(
      `create index "exam_answers_question_idx" on "exam_answers" ("question_id");`,
    );
    await queryRunner.query(
      `create index "exam_answers_correct_idx"  on "exam_answers" ("is_correct");`,
    );

    await queryRunner.query(`
      create table "srs_cards" (
        "id" uuid primary key default gen_random_uuid(),
        "user_id" uuid not null references "users"("id") on delete cascade,
        "question_id" uuid not null references "questions"("id") on delete cascade,
        "question_pool" "question_pool_enum" not null default 'past_paper',
        "ease_factor" float not null default 2.5,
        "interval_days" int not null default 1,
        "repetitions" int not null default 0,
        "last_quality" int,
        "next_review_at" timestamptz not null default now(),
        "last_reviewed_at" timestamptz,
        "created_at" timestamptz not null default now(),
        constraint "srs_user_question_pool_uq" unique ("user_id","question_id","question_pool")
      );
    `);
    await queryRunner.query(
      `create index "idx_srs_due"              on "srs_cards" ("user_id","next_review_at");`,
    );

    await queryRunner.query(`
      create table "user_subject_progress" (
        "id" uuid primary key default gen_random_uuid(),
        "user_id" uuid not null references "users"("id") on delete cascade,
        "subject_id" uuid not null references "subjects"("id") on delete cascade,
        "questions_seen" int not null default 0,
        "questions_correct" int not null default 0,
        "total_time_ms" bigint not null default 0,
        "streak_days" int not null default 0,
        "longest_streak" int not null default 0,
        "topic_accuracy" jsonb,
        "last_studied_at" timestamptz,
        "updated_at" timestamptz not null default now(),
        constraint "usp_user_subject_uq" unique ("user_id","subject_id")
      );
    `);
    await queryRunner.query(
      `create index "usp_user_idx" on "user_subject_progress" ("user_id");`,
    );

    // -----------------------------------------------------------------------
    // Gamification: leaderboard + winners + referrals + XP ledger
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      create table "leaderboard_entries" (
        "id" uuid primary key default gen_random_uuid(),
        "user_id" uuid not null references "users"("id") on delete cascade,
        "exam_type" "exam_type_enum" not null,
        "scope" text not null default 'national',
        "period_type" "leaderboard_period_type_enum" not null,
        "period_start" date not null,
        "weekly_xp" int not null default 0,
        "rank" int,
        "created_at" timestamptz not null default now(),
        constraint "lb_unique" unique ("user_id","exam_type","scope","period_type","period_start")
      );
    `);
    await queryRunner.query(
      `create index "idx_lb_period" on "leaderboard_entries" ("exam_type","period_type","period_start","weekly_xp" desc);`,
    );

    await queryRunner.query(`
      create table "winners" (
        "id" uuid primary key default gen_random_uuid(),
        "user_id" uuid not null references "users"("id") on delete restrict,
        "exam_type" "exam_type_enum" not null,
        "period_type" "leaderboard_period_type_enum" not null,
        "period_start" date not null,
        "rank" int not null,
        "xp_earned" int not null,
        "xp_issued" boolean not null default false,
        "xp_issued_at" timestamptz,
        "created_at" timestamptz not null default now()
      );
    `);
    await queryRunner.query(
      `create index "idx_winners_period" on "winners" ("exam_type","period_type","period_start","rank");`,
    );

    await queryRunner.query(`
      create table "referral_events" (
        "id" uuid primary key default gen_random_uuid(),
        "referrer_id" uuid not null references "users"("id") on delete cascade,
        "referred_id" uuid not null references "users"("id") on delete cascade,
        "referral_code" text not null,
        "signup_xp_issued" boolean not null default false,
        "qualify_xp_issued" boolean not null default false,
        "qualified_at" timestamptz,
        "created_at" timestamptz not null default now()
      );
    `);
    await queryRunner.query(
      `create index "idx_referral_referrer" on "referral_events" ("referrer_id");`,
    );
    await queryRunner.query(
      `create index "idx_referral_referred" on "referral_events" ("referred_id");`,
    );

    await queryRunner.query(`
      create table "xp_rate_config" (
        "id" uuid primary key default gen_random_uuid(),
        "event_key" text not null unique,
        "label" text not null,
        "xp_amount" int not null,
        "is_active" boolean not null default true,
        "updated_at" timestamptz not null default now()
      );
    `);
    await queryRunner.query(`
      create table "xp_redemption_config" (
        "id" uuid primary key default gen_random_uuid(),
        "tier_key" text not null unique,
        "label" text not null,
        "xp_cost" int not null,
        "credit_days" int not null,
        "is_active" boolean not null default true,
        "updated_at" timestamptz not null default now()
      );
    `);
    await queryRunner.query(`
      create table "xp_transactions" (
        "id" uuid primary key default gen_random_uuid(),
        "user_id" uuid not null references "users"("id") on delete cascade,
        "event_key" text not null,
        "level_xp" int not null default 0,
        "spendable_xp" int not null default 0,
        "reference_id" uuid,
        "created_at" timestamptz not null default now()
      );
    `);
    await queryRunner.query(
      `create index "idx_xp_tx_user" on "xp_transactions" ("user_id","created_at" desc);`,
    );
    await queryRunner.query(`
      create table "xp_redemptions" (
        "id" uuid primary key default gen_random_uuid(),
        "user_id" uuid not null references "users"("id") on delete cascade,
        "tier_key" text not null,
        "xp_spent" int not null,
        "credit_days" int not null,
        "applied_at" timestamptz not null default now()
      );
    `);

    // -----------------------------------------------------------------------
    // Subscriptions + payments + price config + ads
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      create table "subscriptions" (
        "id" uuid primary key default gen_random_uuid(),
        "user_id" uuid not null references "users"("id") on delete cascade,
        "plan" "subscriptions_plan_enum" not null,
        "status" "subscriptions_status_enum" not null default 'trial',
        "paystack_ref" text,
        "paystack_sub_code" text,
        "paystack_customer" text,
        "amount_ghs" numeric(10,2),
        "xp_redemption_id" uuid references "xp_redemptions"("id") on delete set null,
        "country_code" varchar(2) not null default 'GH',
        "starts_at" timestamptz not null default now(),
        "expires_at" timestamptz,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now()
      );
    `);
    await queryRunner.query(
      `create index "idx_subs_user"            on "subscriptions" ("user_id","status");`,
    );
    await queryRunner.query(
      `create index "idx_subs_expiry"          on "subscriptions" ("status","expires_at");`,
    );

    await queryRunner.query(`
      create table "subscription_price_config" (
        "id" uuid primary key default gen_random_uuid(),
        "monthly_price_ghs" numeric(10,2) not null,
        "termly_multiplier" numeric(5,2) not null default 2.5,
        "annual_multiplier" numeric(5,2) not null default 9.0,
        "currency" text not null default 'GHS',
        "paystack_plan_monthly" text,
        "paystack_plan_termly"  text,
        "paystack_plan_annual"  text,
        "is_active" boolean not null default true,
        "updated_by" uuid references "users"("id") on delete set null,
        "updated_at" timestamptz not null default now()
      );
    `);

    await queryRunner.query(`
      create table "payment_events" (
        "id" uuid primary key default gen_random_uuid(),
        "user_id" uuid references "users"("id") on delete set null,
        "paystack_event_id" text not null unique,
        "event_type" text not null,
        "raw_payload" jsonb not null,
        "processed" boolean not null default false,
        "processed_at" timestamptz,
        "error" text,
        "created_at" timestamptz not null default now()
      );
    `);
    await queryRunner.query(
      `create index "payment_events_type_idx"      on "payment_events" ("event_type");`,
    );
    await queryRunner.query(
      `create index "payment_events_processed_idx" on "payment_events" ("processed");`,
    );

    await queryRunner.query(`
      create table "ad_config" (
        "id" uuid primary key default gen_random_uuid(),
        "ads_enabled" boolean not null default false,
        "ad_network" text not null default 'admob',
        "admob_app_id" text,
        "admob_interstitial_id" text,
        "admob_rewarded_id" text,
        "rewarded_xp_amount" int not null default 5,
        "frequency_cap" int not null default 3,
        "trigger_event" text not null default 'exam_complete',
        "updated_at" timestamptz not null default now()
      );
    `);

    // -----------------------------------------------------------------------
    // AI infrastructure: prompts, usage log, generation jobs
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      create table "prompt_templates" (
        "id" uuid primary key default gen_random_uuid(),
        "name" text not null,
        "version" text not null,
        "content" text not null,
        "is_active" boolean not null default true,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "prompt_templates_name_version_uq" unique ("name","version")
      );
    `);
    await queryRunner.query(
      `create unique index "prompt_templates_active_uq" on "prompt_templates" ("name") where "is_active" = true;`,
    );

    await queryRunner.query(`
      create table "ai_usage_log" (
        "id" uuid primary key default gen_random_uuid(),
        "user_id" uuid references "users"("id") on delete set null,
        "question_id" uuid references "questions"("id") on delete set null,
        "job_id" uuid,
        "action" "ai_usage_log_action_enum" not null,
        "model" text not null,
        "input_tokens" int,
        "output_tokens" int,
        "cost_usd" numeric(12,6),
        "latency_ms" int,
        "cache_hit" boolean not null default false,
        "failover_used" boolean not null default false,
        "prompt_version" text,
        "created_at" timestamptz not null default now()
      );
    `);
    await queryRunner.query(
      `create index "ai_usage_created_idx" on "ai_usage_log" ("created_at");`,
    );
    await queryRunner.query(
      `create index "ai_usage_user_idx"    on "ai_usage_log" ("user_id");`,
    );

    await queryRunner.query(`
      create table "ai_generation_jobs" (
        "id" uuid primary key default gen_random_uuid(),
        "job_type" "ai_job_type_enum" not null,
        "status" "ai_job_status_enum" not null default 'pending',
        "triggered_by" uuid not null references "users"("id") on delete restrict,
        "parameters" jsonb not null,
        "total_items" int,
        "completed_items" int not null default 0,
        "failed_items" int not null default 0,
        "estimated_cost_usd" numeric(10,4),
        "actual_cost_usd" numeric(10,4),
        "model_used" text,
        "started_at" timestamptz,
        "completed_at" timestamptz,
        "error_log" text,
        "created_at" timestamptz not null default now()
      );
    `);
    // Spec §7.2: ai_usage_log.job_id → ai_generation_jobs.id. Added as ALTER
    // because ai_usage_log is created before ai_generation_jobs.
    await queryRunner.query(`
      alter table "ai_usage_log"
        add constraint "ai_usage_log_job_fk"
        foreign key ("job_id") references "ai_generation_jobs"("id")
        on delete set null;
    `);

    // -----------------------------------------------------------------------
    // Admin + student-facing: question flags, notifications, audit_log
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      create table "question_flags" (
        "id" uuid primary key default gen_random_uuid(),
        "question_id" uuid not null references "questions"("id") on delete cascade,
        "question_pool" "question_pool_enum" not null default 'past_paper',
        "user_id" uuid not null references "users"("id"),
        "reason" text not null,
        "note" text,
        "is_resolved" boolean not null default false,
        "resolved_by" uuid,
        "resolved_at" timestamptz,
        "created_at" timestamptz not null default now()
      );
    `);
    await queryRunner.query(
      `create index "question_flags_q_resolved_idx" on "question_flags" ("question_id","is_resolved");`,
    );

    await queryRunner.query(`
      create table "notifications" (
        "id" uuid primary key default gen_random_uuid(),
        "user_id" uuid not null references "users"("id") on delete cascade,
        "channel" "notifications_channel_enum" not null default 'in_app',
        "title" text not null,
        "body" text not null,
        "data" jsonb,
        "is_read" boolean not null default false,
        "sent_at" timestamptz,
        "created_at" timestamptz not null default now()
      );
    `);
    await queryRunner.query(
      `create index "idx_notifs_user" on "notifications" ("user_id","is_read");`,
    );

    await queryRunner.query(`
      create table "audit_log" (
        "id" uuid primary key default gen_random_uuid(),
        "admin_id" uuid not null references "users"("id") on delete restrict,
        "action" text not null,
        "entity_type" text not null,
        "entity_id" uuid,
        "old_value" jsonb,
        "new_value" jsonb,
        "ip_address" text,
        "created_at" timestamptz not null default now()
      );
    `);
    await queryRunner.query(
      `create index "audit_log_admin_idx"  on "audit_log" ("admin_id");`,
    );
    await queryRunner.query(
      `create index "audit_log_entity_idx" on "audit_log" ("entity_type","entity_id");`,
    );

    // -----------------------------------------------------------------------
    // Seeds — admin-editable config defaults
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      insert into "xp_rate_config" (event_key, label, xp_amount) values
        ('correct_past_paper',   'Correct answer — past paper',       10),
        ('correct_pm_test',      'Correct answer — PM Test',          15),
        ('exam_complete',        'Exam completion bonus',             20),
        ('exam_perfect',         'Perfect score bonus',               50),
        ('streak_day',           'Daily streak maintained',            5),
        ('streak_7',             'Streak milestone — 7 days',         50),
        ('streak_14',            'Streak milestone — 14 days',       100),
        ('streak_30',            'Streak milestone — 30 days',       300),
        ('streak_50',            'Streak milestone — 50 days',       500),
        ('streak_100',           'Streak milestone — 100 days',     1000),
        ('srs_review',           'Daily SRS review complete',         10),
        ('first_topic',          'First attempt on new topic',        15),
        ('referral_referred',    'New user signs up with your code',  50),
        ('referral_qualified',   'Referral qualifies (10 questions)',100),
        ('referral_new_user',    'You joined with a referral code',   30),
        ('weekly_winner_1',      'Weekly leaderboard rank 1',       2000),
        ('weekly_winner_2',      'Weekly leaderboard rank 2',       1500),
        ('weekly_winner_3',      'Weekly leaderboard rank 3',       1000),
        ('weekly_winner_4_10',   'Weekly leaderboard rank 4–10',     700),
        ('weekly_winner_11_20',  'Weekly leaderboard rank 11–20',    500),
        ('monthly_winner_1',     'Monthly leaderboard rank 1',      5000),
        ('monthly_winner_2_3',   'Monthly leaderboard rank 2–3',    3000),
        ('monthly_winner_4_10',  'Monthly leaderboard rank 4–10',   2000),
        ('monthly_winner_11_20', 'Monthly leaderboard rank 11–20',  1000);
    `);
    await queryRunner.query(`
      insert into "xp_redemption_config" (tier_key, label, xp_cost, credit_days) values
        ('week_1',  '1 week free subscription',     5000,   7),
        ('month_1', '1 month free subscription',   15000,  30),
        ('term_1',  '1 term free subscription',    40000,  90),
        ('year_1',  '1 year free subscription',   120000, 365);
    `);
    await queryRunner.query(`insert into "ad_config" default values;`);

    // Subjects seed (spec §2.2). Both exam platforms, canonical codes.
    await queryRunner.query(`
      insert into "subjects" (code, name, exam_type, category, is_core, sort_order) values
        ('BECE_MATHS',        'Mathematics',           'bece','core',    true,  1),
        ('BECE_ENGLISH',      'English Language',      'bece','core',    true,  2),
        ('BECE_SCIENCE',      'Integrated Science',    'bece','core',    true,  3),
        ('BECE_SOCIAL',       'Social Studies',        'bece','core',    true,  4),
        ('BECE_RME',          'Religious & Moral Ed',  'bece','core',    true,  5),
        ('BECE_BDT',          'BDT',                   'bece','core',    true,  6),
        ('BECE_FRENCH',       'French',                'bece','elective',false, 7),
        ('BECE_GHANALANG',    'Ghanaian Language',     'bece','core',    true,  8),
        ('WASSCE_CORE_MATHS', 'Core Mathematics',      'wassce','core',    true,  1),
        ('WASSCE_ENGLISH',    'English Language',      'wassce','core',    true,  2),
        ('WASSCE_INT_SCI',    'Integrated Science',    'wassce','core',    true,  3),
        ('WASSCE_SOC_STUD',   'Social Studies',        'wassce','core',    true,  4),
        ('WASSCE_ELEC_MATHS', 'Elective Mathematics',  'wassce','elective',false, 5),
        ('WASSCE_PHYSICS',    'Physics',               'wassce','elective',false, 6),
        ('WASSCE_CHEMISTRY',  'Chemistry',             'wassce','elective',false, 7),
        ('WASSCE_BIOLOGY',    'Biology',               'wassce','elective',false, 8),
        ('WASSCE_ECON',       'Economics',             'wassce','elective',false, 9),
        ('WASSCE_GEOG',       'Geography',             'wassce','elective',false, 10),
        ('WASSCE_HISTORY',    'History',               'wassce','elective',false, 11),
        ('WASSCE_LIT',        'Literature in English', 'wassce','elective',false, 12),
        ('WASSCE_ICT',        'ICT',                   'wassce','elective',false, 13),
        ('WASSCE_FRENCH',     'French',                'wassce','elective',false, 14)
      on conflict (code) do nothing;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists "audit_log" cascade;`);
    await queryRunner.query(`drop table if exists "notifications" cascade;`);
    await queryRunner.query(`drop table if exists "question_flags" cascade;`);
    await queryRunner.query(
      `drop table if exists "ai_generation_jobs" cascade;`,
    );
    await queryRunner.query(`drop table if exists "ai_usage_log" cascade;`);
    await queryRunner.query(`drop table if exists "prompt_templates" cascade;`);
    await queryRunner.query(`drop table if exists "ad_config" cascade;`);
    await queryRunner.query(`drop table if exists "payment_events" cascade;`);
    await queryRunner.query(
      `drop table if exists "subscription_price_config" cascade;`,
    );
    await queryRunner.query(`drop table if exists "subscriptions" cascade;`);
    await queryRunner.query(`drop table if exists "xp_redemptions" cascade;`);
    await queryRunner.query(`drop table if exists "xp_transactions" cascade;`);
    await queryRunner.query(
      `drop table if exists "xp_redemption_config" cascade;`,
    );
    await queryRunner.query(`drop table if exists "xp_rate_config" cascade;`);
    await queryRunner.query(`drop table if exists "referral_events" cascade;`);
    await queryRunner.query(`drop table if exists "winners" cascade;`);
    await queryRunner.query(
      `drop table if exists "leaderboard_entries" cascade;`,
    );
    await queryRunner.query(
      `drop table if exists "user_subject_progress" cascade;`,
    );
    await queryRunner.query(`drop table if exists "srs_cards" cascade;`);
    await queryRunner.query(`drop table if exists "exam_answers" cascade;`);
    await queryRunner.query(`drop table if exists "exams" cascade;`);
    await queryRunner.query(`drop table if exists "pm_test_options" cascade;`);
    await queryRunner.query(
      `drop table if exists "pm_test_questions" cascade;`,
    );
    await queryRunner.query(`drop table if exists "options" cascade;`);
    await queryRunner.query(`drop table if exists "questions" cascade;`);
    await queryRunner.query(`drop table if exists "syllabus_topics" cascade;`);
    await queryRunner.query(`drop table if exists "topics" cascade;`);
    await queryRunner.query(`drop table if exists "subjects" cascade;`);
    await queryRunner.query(`drop table if exists "device_sessions" cascade;`);
    await queryRunner.query(`drop table if exists "school_members" cascade;`);
    await queryRunner.query(`drop table if exists "schools" cascade;`);
    await queryRunner.query(`drop table if exists "users" cascade;`);

    for (const enumName of [
      'leaderboard_period_type_enum',
      'ai_job_status_enum',
      'ai_job_type_enum',
      'ai_usage_log_action_enum',
      'school_members_role_enum',
      'notifications_channel_enum',
      'subscriptions_status_enum',
      'subscriptions_plan_enum',
      'exams_status_enum',
      'exams_mode_enum',
      'question_pool_enum',
      'question_status_enum',
      'questions_difficulty_enum',
      'questions_source_enum',
      'questions_question_type_enum',
      'subjects_category_enum',
      'school_level_enum',
      'exam_type_enum',
      'users_auth_provider_enum',
      'users_role_enum',
    ]) {
      await queryRunner.query(`drop type if exists "${enumName}";`);
    }
  }
}
