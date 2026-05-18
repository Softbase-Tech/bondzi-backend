import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Week 2-3 medium-priority migration.
 *
 *   - updated_at on entities that change after creation but lacked it
 *     (exams, leaderboard_entries, winners, notifications, options) so
 *     audit / forensic queries can answer "when was this row last
 *     touched?". Backfilled to created_at on existing rows.
 *
 *   - Soft-delete (deleted_at) on subscription_plan, subjects, topics.
 *     The app uses is_active=false as a "soft archive" today but a real
 *     deleted_at timestamp + index lets the admin list "what was
 *     archived this month" without a custom audit table, and pairs
 *     cleanly with TypeORM's `@DeleteDateColumn`.
 *
 *   - GIN indexes on the JSONB columns admins search:
 *     audit_log.old_value, audit_log.new_value, payment_events.raw_payload,
 *     notifications.data. Without these the admin "find by metadata"
 *     paths walk the whole table.
 *
 *   - Partial index on srs_cards where interval_days > 21 (the "mastered"
 *     bucket the user dashboard counts).
 *
 *   - CHECK constraint on question_flags.reason — the spec keeps the
 *     column TEXT for admin flexibility, but app-layer validation
 *     restricts inserts to FlagReason values. A CHECK constraint makes
 *     the same restriction true for any direct SQL writes (bulk imports
 *     from a future moderation tool, ad-hoc admin SQL, etc.).
 *
 *   - Drops the duplicate idx_xp_transactions_user_created_at — the
 *     entity-side @Index('idx_xp_tx_user', ['userId','createdAt']) and
 *     the original InitialSchemaV2 migration already cover the same
 *     (user_id, created_at desc) pair. Having two costs ~30MB at 1M
 *     rows and adds an extra B-tree write on every insert.
 */
export class MediumPriorityAuditAndDX_1810000000000 implements MigrationInterface {
  name = 'MediumPriorityAuditAndDX_1810000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ============================================================
    // updated_at columns (audit / forensics)
    // ============================================================
    // Each ALTER is idempotent. The default `now()` makes future
    // inserts self-stamp; the application sets it via
    // @UpdateDateColumn on entity save.
    //
    // Two groups because `options` is the odd one out — it has no
    // created_at column (legacy: the original schema treated options
    // as immutable children of the question row). Tables with a
    // created_at get the new column backfilled to the original
    // insert time so historical rows show a sensible value rather
    // than the migration's clock; options just inherits the
    // default NOW() for existing rows.
    const updatedAtTablesWithCreatedAt = [
      'exams',
      'leaderboard_entries',
      'winners',
      'notifications',
    ] as const;
    for (const table of updatedAtTablesWithCreatedAt) {
      await queryRunner.query(`
        alter table "${table}"
        add column if not exists "updated_at" timestamptz not null default now();
      `);
      // Idempotent: re-running this migration after a partial deploy
      // re-stamps already-touched rows to the same value. Cheap and
      // safe.
      await queryRunner.query(`
        update "${table}" set "updated_at" = "created_at"
        where "created_at" is not null;
      `);
    }
    // options has no created_at — leave the default `now()` value on
    // existing rows. Future updates will stamp it correctly.
    await queryRunner.query(`
      alter table "options"
      add column if not exists "updated_at" timestamptz not null default now();
    `);

    // ============================================================
    // Soft-delete (deleted_at)
    // ============================================================
    const softDeleteTables = [
      'subscription_plan',
      'subjects',
      'topics',
    ] as const;
    for (const table of softDeleteTables) {
      await queryRunner.query(`
        alter table "${table}"
        add column if not exists "deleted_at" timestamptz;
      `);
      // Index only the soft-deleted rows — a partial index is much
      // smaller than a full one when most rows are alive, and it
      // accelerates the "list everything deleted in window X" admin view.
      await queryRunner.query(`
        create index if not exists "idx_${table}_deleted_at"
          on "${table}" ("deleted_at")
          where "deleted_at" is not null;
      `);
    }

    // ============================================================
    // GIN indexes on JSONB
    // ============================================================
    // GIN over the whole document supports both @> containment and
    // -> key lookups, so the admin can search by event type or
    // metadata key without a function-based index. Add `jsonb_path_ops`
    // operator class for tighter @>-only queries on the largest column.
    await queryRunner.query(`
      create index if not exists "idx_audit_log_old_value_gin"
        on "audit_log" using gin ("old_value");
    `);
    await queryRunner.query(`
      create index if not exists "idx_audit_log_new_value_gin"
        on "audit_log" using gin ("new_value");
    `);
    await queryRunner.query(`
      create index if not exists "idx_payment_events_raw_payload_gin"
        on "payment_events" using gin ("raw_payload" jsonb_path_ops);
    `);
    await queryRunner.query(`
      create index if not exists "idx_notifications_data_gin"
        on "notifications" using gin ("data");
    `);

    // ============================================================
    // srs_cards "mastered" partial index
    // ============================================================
    // The user dashboard renders "X cards mastered" by counting cards
    // with interval_days > 21. Without this index the count is a seq
    // scan; with it Postgres maintains the row set as cards graduate.
    await queryRunner.query(`
      create index if not exists "idx_srs_cards_mastered"
        on "srs_cards" ("user_id")
        where "interval_days" > 21;
    `);

    // ============================================================
    // question_flags.reason CHECK constraint
    // ============================================================
    // Mirrors the FlagReason TypeScript enum exactly. Wrapped in a
    // DO block so the migration is idempotent — the constraint may
    // already exist from a partial deploy retry.
    await queryRunner.query(`
      do $$
      begin
        if not exists (
          select 1 from information_schema.constraint_column_usage
          where constraint_name = 'question_flags_reason_check'
        ) then
          alter table "question_flags"
            add constraint "question_flags_reason_check"
            check (reason in (
              'wrong_answer',
              'typo',
              'bad_image',
              'outdated',
              'duplicate',
              'other'
            ));
        end if;
      end$$;
    `);

    // ============================================================
    // device_sessions — refresh-token rotation forensics (#98)
    // ============================================================
    // The previous shape had no per-rotation breadcrumb on the
    // session. We add three columns so a security review can
    // distinguish device-swap from token theft: rotation_count
    // (how many times this session refreshed), last_rotated_at,
    // last_rotation_ip. Each rotate() stamps these; an attacker who
    // rotates from a different IP leaves a recognizable trail.
    await queryRunner.query(`
      alter table "device_sessions"
        add column if not exists "rotation_count" int not null default 0;
    `);
    await queryRunner.query(`
      alter table "device_sessions"
        add column if not exists "last_rotated_at" timestamptz;
    `);
    await queryRunner.query(`
      alter table "device_sessions"
        add column if not exists "last_rotation_ip" text;
    `);

    // ============================================================
    // subscription_plan.archive_at — version-bump grace period
    // ============================================================
    // When an admin bumps the price on a plan, the old version doesn't
    // archive immediately any more (#73). It lives on with `archive_at`
    // set to NOW() + CHECKOUT_GRACE_HOURS so any user with a still-open
    // Paystack authorizationUrl referring to v1 can complete checkout
    // and the webhook still resolves the plan. After archive_at, the
    // public list filters the plan out and a cron flips deleted_at
    // to make it a tombstone.
    await queryRunner.query(`
      alter table "subscription_plan"
        add column if not exists "archive_at" timestamptz;
    `);
    await queryRunner.query(`
      create index if not exists "idx_subscription_plan_archive_at"
        on "subscription_plan" ("archive_at")
        where "archive_at" is not null;
    `);

    // ============================================================
    // ai_generation_jobs — co-sign columns + PENDING_APPROVAL enum
    // ============================================================
    // High-cost AI jobs (>AI_COSIGN_THRESHOLD_USD) wait in
    // PENDING_APPROVAL until a SECOND admin approves them. The
    // creator's user id is `triggered_by`; the approver's is
    // `approved_by`. A CHECK constraint enforces they differ.
    // NB: the enum is named `ai_job_status_enum` (created in
    // InitialSchemaV2 at line 83), NOT the longer TypeORM auto-naming
    // convention `ai_generation_jobs_status_enum`. The shorter name
    // is shared with ai_job_status anywhere it appears.
    await queryRunner.query(`
      alter type "ai_job_status_enum"
        add value if not exists 'pending_approval' before 'pending';
    `);
    await queryRunner.query(`
      alter table "ai_generation_jobs"
        add column if not exists "approved_by" uuid;
    `);
    await queryRunner.query(`
      alter table "ai_generation_jobs"
        add column if not exists "approved_at" timestamptz;
    `);
    await queryRunner.query(`
      do $$
      begin
        if not exists (
          select 1 from information_schema.constraint_column_usage
          where constraint_name = 'ai_generation_jobs_distinct_cosigners_check'
        ) then
          alter table "ai_generation_jobs"
            add constraint "ai_generation_jobs_distinct_cosigners_check"
            check (approved_by is null or approved_by <> triggered_by);
        end if;
      end$$;
    `);
    await queryRunner.query(`
      do $$
      begin
        if not exists (
          select 1 from pg_constraint
          where conname = 'ai_generation_jobs_approved_by_fkey'
        ) then
          alter table "ai_generation_jobs"
            add constraint "ai_generation_jobs_approved_by_fkey"
            foreign key (approved_by) references users(id) on delete set null;
        end if;
      end$$;
    `);

    // ============================================================
    // financial_events — structured audit for money movements
    // ============================================================
    // Today every activation / cancel / redemption / refund just calls
    // `logger.log("...")`. That's invisible to forensics — if a customer
    // disputes a charge in 4 months, we have no queryable record.
    //
    // This table records every money-touching state change as one
    // immutable row. It is NOT audit_log (which is keyed to an
    // admin_id and is for moderator actions); financial_events is
    // system-driven and includes activations / renewals / refunds
    // triggered by webhooks, XP redemptions, and admin-initiated
    // operations. Indexed by (user_id, created_at) for "show me this
    // user's billing history" and (event_type, created_at) for "show
    // me every refund this week".
    await queryRunner.query(`
      create table if not exists "financial_events" (
        "id" uuid primary key default gen_random_uuid(),
        "event_type" text not null,
        "user_id" uuid,
        "subscription_id" uuid,
        "amount_minor" int,
        "currency" text,
        "source" text not null,
        "actor_id" uuid,
        "metadata" jsonb,
        "created_at" timestamptz not null default now()
      );
    `);
    await queryRunner.query(`
      create index if not exists "idx_financial_events_user_created_at"
        on "financial_events" ("user_id", "created_at" desc);
    `);
    await queryRunner.query(`
      create index if not exists "idx_financial_events_type_created_at"
        on "financial_events" ("event_type", "created_at" desc);
    `);
    await queryRunner.query(`
      create index if not exists "idx_financial_events_subscription"
        on "financial_events" ("subscription_id")
        where "subscription_id" is not null;
    `);

    // ============================================================
    // Drop duplicate xp_transactions index
    // ============================================================
    // Both InitialSchemaV2 (idx_xp_tx_user) and the prior week-1
    // migration (idx_xp_transactions_user_created_at) cover
    // (user_id, created_at desc). Keep the original name (matches
    // the entity @Index decorator); drop the longer-named duplicate.
    await queryRunner.query(`
      drop index if exists "idx_xp_transactions_user_created_at";
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Recreate the dropped duplicate index first so a rollback leaves
    // the schema indistinguishable from pre-up state.
    await queryRunner.query(`
      create index if not exists "idx_xp_transactions_user_created_at"
        on "xp_transactions" ("user_id", "created_at" desc);
    `);

    // financial_events
    await queryRunner.query(
      `drop index if exists "idx_financial_events_subscription";`,
    );
    await queryRunner.query(
      `drop index if exists "idx_financial_events_type_created_at";`,
    );
    await queryRunner.query(
      `drop index if exists "idx_financial_events_user_created_at";`,
    );
    await queryRunner.query(`drop table if exists "financial_events";`);

    // subscription_plan.archive_at rollback
    await queryRunner.query(
      `drop index if exists "idx_subscription_plan_archive_at";`,
    );
    await queryRunner.query(
      `alter table "subscription_plan" drop column if exists "archive_at";`,
    );

    // device_sessions rotation-forensics rollback
    await queryRunner.query(
      `alter table "device_sessions" drop column if exists "last_rotation_ip";`,
    );
    await queryRunner.query(
      `alter table "device_sessions" drop column if exists "last_rotated_at";`,
    );
    await queryRunner.query(
      `alter table "device_sessions" drop column if exists "rotation_count";`,
    );

    // ai_generation_jobs co-sign rollback. We can drop the FK +
    // CHECK + columns; the enum value 'pending_approval' is
    // intentionally NOT dropped — Postgres can't remove enum values
    // without a recreate, and any in-flight rows would point at it.
    await queryRunner.query(`
      alter table "ai_generation_jobs"
        drop constraint if exists "ai_generation_jobs_approved_by_fkey";
    `);
    await queryRunner.query(`
      alter table "ai_generation_jobs"
        drop constraint if exists "ai_generation_jobs_distinct_cosigners_check";
    `);
    await queryRunner.query(`
      alter table "ai_generation_jobs"
        drop column if exists "approved_at";
    `);
    await queryRunner.query(`
      alter table "ai_generation_jobs"
        drop column if exists "approved_by";
    `);

    await queryRunner.query(`
      alter table "question_flags"
        drop constraint if exists "question_flags_reason_check";
    `);

    await queryRunner.query(`drop index if exists "idx_srs_cards_mastered";`);

    await queryRunner.query(
      `drop index if exists "idx_notifications_data_gin";`,
    );
    await queryRunner.query(
      `drop index if exists "idx_payment_events_raw_payload_gin";`,
    );
    await queryRunner.query(
      `drop index if exists "idx_audit_log_new_value_gin";`,
    );
    await queryRunner.query(
      `drop index if exists "idx_audit_log_old_value_gin";`,
    );

    for (const table of ['topics', 'subjects', 'subscription_plan']) {
      await queryRunner.query(
        `drop index if exists "idx_${table}_deleted_at";`,
      );
      await queryRunner.query(
        `alter table "${table}" drop column if exists "deleted_at";`,
      );
    }

    for (const table of [
      'options',
      'notifications',
      'winners',
      'leaderboard_entries',
      'exams',
    ]) {
      await queryRunner.query(
        `alter table "${table}" drop column if exists "updated_at";`,
      );
    }
  }
}
