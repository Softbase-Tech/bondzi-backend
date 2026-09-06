import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Website AdSense config on the single-row ad_config table. jsonb so
 * placements can grow (blog_inline, blog_footer, landing_mid,
 * app_dashboard, …) without further migrations. Seeded disabled with
 * the live publisher id and the blog placements pre-listed so the
 * admin only fills in slot ids and flips toggles.
 */
export class WebAdsConfig_2340000000000 implements MigrationInterface {
  name = 'WebAdsConfig_2340000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ad_config" ADD COLUMN IF NOT EXISTS "web_ads" jsonb NOT NULL DEFAULT '{}'::jsonb`,
    );
    await queryRunner.query(
      `UPDATE "ad_config"
          SET "web_ads" = '{
            "enabled": false,
            "publisherId": "ca-pub-8786512219927724",
            "placements": {
              "blog_inline": { "enabled": false, "slotId": "", "afterBlock": 6 },
              "blog_footer": { "enabled": false, "slotId": "" },
              "landing_mid": { "enabled": false, "slotId": "" },
              "app_dashboard": { "enabled": false, "slotId": "" }
            }
          }'::jsonb
        WHERE "web_ads" = '{}'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ad_config" DROP COLUMN IF EXISTS "web_ads"`,
    );
  }
}
