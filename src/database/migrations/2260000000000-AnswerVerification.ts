import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Answer-verification plumbing (remediation 0.1) + Post-Exam Review
 * entitlement enable (remediation C-zero #7).
 *
 * 1. `pm_test_questions.verification_status` — outcome of the blind
 *    second-pass answer verifier that runs between validation and
 *    insert. Values (text, app-validated — a Postgres enum would need
 *    ALTER TYPE ceremony for every new outcome):
 *      'agreed'         — verifier independently picked the same key
 *      'key_mismatch'   — verifier picked a different option; the item
 *                         needs human review before activation
 *      'verifier_error' — verifier call failed / unparseable; item is
 *                         unverified, not condemned
 *      NULL             — generated before the verifier existed, or
 *                         verifier disabled via env
 *    `verifier_model` records which model performed the check.
 *    The admin review queue filters on this column, so it's indexed
 *    together with status.
 *
 * 2. Enable `post_exam_ai_breakdown` for the PRO tier. The feature is
 *    fully built (exams.service.generateBreakdown) but was seeded
 *    `enabled: false` for every tier — 100% of calls 403'd in
 *    production. Product decision per the premium-quality plan §6.1.7:
 *    Pro gets it now; Free/Plus stay off until the grounded rebuild
 *    lands so their first impression is the good version.
 *    Uses UPDATE (not insert-on-conflict) so an admin's manual edits
 *    to other columns are preserved.
 */
export class AnswerVerification2260000000000 implements MigrationInterface {
  name = 'AnswerVerification2260000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table "pm_test_questions"
        add column if not exists "verification_status" text,
        add column if not exists "verifier_model" text;
    `);
    await queryRunner.query(`
      create index if not exists "idx_pm_test_q_verification"
        on "pm_test_questions" ("verification_status")
        where "verification_status" is not null;
    `);

    await queryRunner.query(`
      update "tier_services"
         set "enabled" = true, "updated_at" = now()
       where "account_type" = 'pro'
         and "service" = 'post_exam_ai_breakdown';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `drop index if exists "idx_pm_test_q_verification";`,
    );
    await queryRunner.query(`
      alter table "pm_test_questions"
        drop column if exists "verification_status",
        drop column if exists "verifier_model";
    `);
    await queryRunner.query(`
      update "tier_services"
         set "enabled" = false, "updated_at" = now()
       where "account_type" = 'pro'
         and "service" = 'post_exam_ai_breakdown';
    `);
  }
}
