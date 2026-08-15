import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `mode` to `weakness_narratives`. Distinguishes bootstrap prose
 * (no Bedrock, no entitlement) from personalised prose so the client
 * can decide whether the Home card is worth showing.
 *
 * Existing rows are backfilled to 'personalised' — every row created
 * before this migration already cost a Bedrock call.
 */
export class WeaknessNarrativeMode_2090000000000 implements MigrationInterface {
  name = 'WeaknessNarrativeMode_2090000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE weakness_narratives
      ADD COLUMN mode text NOT NULL DEFAULT 'personalised'
    `);
    await queryRunner.query(`
      ALTER TABLE weakness_narratives
      ADD CONSTRAINT weakness_narratives_mode_chk
      CHECK (mode IN ('bootstrap', 'personalised'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE weakness_narratives
      DROP CONSTRAINT IF EXISTS weakness_narratives_mode_chk
    `);
    await queryRunner.query(`
      ALTER TABLE weakness_narratives DROP COLUMN mode
    `);
  }
}
