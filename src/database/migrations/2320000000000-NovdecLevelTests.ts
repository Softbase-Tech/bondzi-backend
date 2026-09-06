import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Open level tests (the Quiz / PM Test surface) to NOVDEC students.
 *
 * The 1960 entitlement seed stamped `requiresFormLevel: true` on every
 * level_tests tier row, on the assumption that NOVDEC (form_level =
 * null) couldn't use the feature. The exam service has since outgrown
 * that: PM-test question selection explicitly handles the NULL form
 * level (NOVDEC draws from the WASSCE-tagged pool with the form filter
 * skipped), and the NOVDEC Pro plan is SOLD with "unlimited adaptive
 * Quiz sessions" and level tests on its card.
 *
 * Net effect of the stale flag in production: every NOVDEC student —
 * including paying Pro users — got a 403 on "Start quiz" and was
 * bounced to the plans page they had already purchased from.
 *
 * The `requiresFormLevel` mechanism itself stays (harmless, and still
 * available for genuinely form-scoped features); only the level_tests
 * rows stop using it.
 */
export class NovdecLevelTests_2320000000000 implements MigrationInterface {
  name = 'NovdecLevelTests_2320000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "tier_services"
          SET "config" = "config" - 'requiresFormLevel'
        WHERE "service" = 'level_tests'
          AND ("config" ->> 'requiresFormLevel') = 'true'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "tier_services"
          SET "config" = "config" || '{"requiresFormLevel": true}'::jsonb
        WHERE "service" = 'level_tests'`,
    );
  }
}
