import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Launch-blocking schema fix.
 *
 * `exam_answers.question_id`, `srs_cards.question_id`, and
 * `question_flags.question_id` all carry a hard FK to `questions(id)` —
 * but at runtime these columns are POLYMORPHIC, also holding
 * `pm_test_questions(id)` values when `question_pool = 'pm_test'`. Every
 * PM-Test answer / SRS card / flag insert would therefore be rejected
 * by Postgres with a foreign-key violation against `questions(id)`.
 *
 * The fix is to drop the FK constraints; integrity is enforced at the
 * application layer (services branch on `question_pool` before resolving
 * the row to the right repository). The TypeORM entity decorators are
 * marked `createForeignKeyConstraints: false` to keep `migration:generate`
 * from re-creating them on the next schema diff.
 *
 * The FK names below match the Postgres auto-generated `fk_*` pattern that
 * the inline `references "questions"("id")` in `InitialSchemaV2` produces.
 * We probe by table+column rather than by constraint name to be resilient
 * to alternate generators in dev/CI databases.
 */
export class DropPolymorphicQuestionFks_1790000000000 implements MigrationInterface {
  name = 'DropPolymorphicQuestionFks_1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.dropFkOn(queryRunner, 'exam_answers', 'question_id');
    await this.dropFkOn(queryRunner, 'srs_cards', 'question_id');
    await this.dropFkOn(queryRunner, 'question_flags', 'question_id');

    // Unique partial index on (provider, provider_reference) — required
    // for webhook idempotency. Two near-simultaneous `charge.success`
    // deliveries for the same Paystack reference would otherwise create
    // duplicate ACTIVE subscription rows. Partial on
    // `provider_reference IS NOT NULL` so XP-credited rows (which have
    // NULL reference) are exempt.
    await queryRunner.query(`
      create unique index if not exists "uq_subscriptions_provider_ref"
        on "subscriptions" ("provider", "provider_reference")
        where "provider_reference" is not null;
    `);

    // Index on payment_events(processed, created_at) — drives the
    // reconciliation cron that re-processes anything stuck with
    // processed=false past a grace window.
    await queryRunner.query(`
      create index if not exists "idx_payment_events_unprocessed"
        on "payment_events" ("processed", "created_at")
        where "processed" = false;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `drop index if exists "idx_payment_events_unprocessed";`,
    );
    await queryRunner.query(
      `drop index if exists "uq_subscriptions_provider_ref";`,
    );
    // Down-migration intentionally re-adds the constraints with the SAME
    // semantics as the original schema. Running it on a database that
    // already contains PM-Test answers will FAIL — that's correct: the
    // FK was never a valid model for the polymorphic column.
    await queryRunner.query(`
      alter table "exam_answers"
        add constraint "fk_exam_answers_question_id"
        foreign key ("question_id") references "questions"("id")
        on delete restrict;
    `);
    await queryRunner.query(`
      alter table "srs_cards"
        add constraint "fk_srs_cards_question_id"
        foreign key ("question_id") references "questions"("id")
        on delete cascade;
    `);
    await queryRunner.query(`
      alter table "question_flags"
        add constraint "fk_question_flags_question_id"
        foreign key ("question_id") references "questions"("id")
        on delete cascade;
    `);
  }

  /**
   * Drop whichever FK constraint targets `(<table>, <column>) -> questions(id)`,
   * regardless of its auto-generated name. Uses `information_schema` so the
   * migration is portable across local dev DBs that may have different
   * constraint names than production.
   */
  private async dropFkOn(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ): Promise<void> {
    const rows = (await queryRunner.query(
      `
        select tc.constraint_name
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu
          on kcu.constraint_name = tc.constraint_name
         and kcu.table_schema = tc.table_schema
        join information_schema.referential_constraints rc
          on rc.constraint_name = tc.constraint_name
        join information_schema.constraint_column_usage ccu
          on ccu.constraint_name = tc.constraint_name
        where tc.table_name = $1
          and kcu.column_name = $2
          and ccu.table_name = 'questions'
          and tc.constraint_type = 'FOREIGN KEY';
      `,
      [table, column],
    )) as { constraint_name: string }[];
    for (const row of rows) {
      await queryRunner.query(
        `alter table "${table}" drop constraint "${row.constraint_name}";`,
      );
    }
  }
}
