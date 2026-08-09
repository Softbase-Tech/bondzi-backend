import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Week-1 perf + correctness migration.
 *
 *   - Adds hot-path indexes the audit flagged: notification inbox sort,
 *     subscription plan FK, ai_usage_log per-question/per-job, device
 *     session by deviceId, pm_test composite by syllabus_topic_id and
 *     generation_batch_id, exams resume sort.
 *   - Adds a partial GIN expression index on `payment_events.user_id` so
 *     `PaymentsService.listUserPayments` doesn't seq-scan the table.
 *     (The real fix is to query the denormalised `user_id` column —
 *     done in app code — but the column itself benefits from an index.)
 *   - Adds a check constraint on `users` requiring at least one of
 *     (email, phone). The app-layer guard already exists; the DB-level
 *     constraint guarantees no future admin-created account is
 *     unreachable.
 *
 * All `if not exists` guards make this idempotent so a partial deploy
 * retry is safe.
 */
export class HighPriorityIndexesAndConstraints_1800000000000 implements MigrationInterface {
  name = 'HighPriorityIndexesAndConstraints_1800000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Notification inbox — pagination orders by created_at DESC. The
    // existing (user_id, is_read) index doesn't cover the sort, forcing
    // an in-memory filesort on every read.
    await queryRunner.query(`
      create index if not exists "idx_notifications_user_created_at"
        on "notifications" ("user_id", "created_at" desc);
    `);

    // Subscription plan FK — joined on every plan-info read.
    await queryRunner.query(`
      create index if not exists "idx_subscriptions_plan_id"
        on "subscriptions" ("plan_id");
    `);

    // ai_usage_log — admin breakdowns filter by question / job.
    await queryRunner.query(`
      create index if not exists "idx_ai_usage_question_id"
        on "ai_usage_log" ("question_id");
    `);
    await queryRunner.query(`
      create index if not exists "idx_ai_usage_job_id"
        on "ai_usage_log" ("job_id");
    `);

    // device_sessions(device_id) — used by logout-by-device lookups
    // and by the device-binding cache fallback.
    await queryRunner.query(`
      create index if not exists "idx_device_sessions_device_id"
        on "device_sessions" ("device_id");
    `);

    // pm_test_questions secondary FKs — joined on syllabus_topic_id /
    // generation_batch_id; the existing composite covers subject_id only.
    await queryRunner.query(`
      create index if not exists "idx_pm_test_q_syllabus_topic_id"
        on "pm_test_questions" ("syllabus_topic_id");
    `);
    await queryRunner.query(`
      create index if not exists "idx_pm_test_q_generation_batch_id"
        on "pm_test_questions" ("generation_batch_id");
    `);

    // Exams resume / history — order by (user_id, status, started_at DESC).
    // Replaces a filesort on every home-screen "continue where you left
    // off" lookup.
    await queryRunner.query(`
      create index if not exists "idx_exams_user_status_started_at"
        on "exams" ("user_id", "status", "started_at" desc);
    `);

    // Payment events — `PaymentsService.listUserPayments` now queries by
    // user_id directly. Existing `payment_events_processed_idx` doesn't
    // help; this one does.
    await queryRunner.query(`
      create index if not exists "idx_payment_events_user_id"
        on "payment_events" ("user_id");
    `);

    // xp_transactions(user_id, created_at DESC) — drives the profile
    // activity feed. Match the migration index direction to the
    // entity-side ASC drift the audit flagged (#10/#25): we explicitly
    // declare DESC so the hot read short-circuits the sort step.
    await queryRunner.query(`
      create index if not exists "idx_xp_transactions_user_created_at"
        on "xp_transactions" ("user_id", "created_at" desc);
    `);

    // users — at least one of (email, phone) must be set. Application
    // layer already enforces this in /auth/register, but a buggy admin
    // endpoint or direct SQL could create an unreachable account. The
    // partial check kicks in for any new INSERT/UPDATE; `NOT VALID`
    // skips the backfill scan on existing rows so the migration is
    // cheap on a populated DB.
    //
    // Postgres doesn't support `ADD CONSTRAINT IF NOT EXISTS` for CHECK,
    // so guard with an information_schema probe to keep the migration
    // idempotent across retries.
    await queryRunner.query(`
      do $$ begin
        if not exists (
          select 1 from information_schema.constraint_column_usage
          where table_name = 'users'
            and constraint_name = 'users_contact_required_chk'
        ) then
          alter table "users"
            add constraint "users_contact_required_chk"
            check ("email" is not null or "phone" is not null)
            not valid;
        end if;
      end $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table "users" drop constraint if exists "users_contact_required_chk";
    `);
    await queryRunner.query(
      `drop index if exists "idx_xp_transactions_user_created_at";`,
    );
    await queryRunner.query(
      `drop index if exists "idx_payment_events_user_id";`,
    );
    await queryRunner.query(
      `drop index if exists "idx_exams_user_status_started_at";`,
    );
    await queryRunner.query(
      `drop index if exists "idx_pm_test_q_generation_batch_id";`,
    );
    await queryRunner.query(
      `drop index if exists "idx_pm_test_q_syllabus_topic_id";`,
    );
    await queryRunner.query(
      `drop index if exists "idx_device_sessions_device_id";`,
    );
    await queryRunner.query(`drop index if exists "idx_ai_usage_job_id";`);
    await queryRunner.query(`drop index if exists "idx_ai_usage_question_id";`);
    await queryRunner.query(
      `drop index if exists "idx_subscriptions_plan_id";`,
    );
    await queryRunner.query(
      `drop index if exists "idx_notifications_user_created_at";`,
    );
  }
}
