import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Partner banner gallery — Phase 6.
 *
 * Admin uploads shareable images (Instagram tile, WhatsApp status,
 * Twitter/X card) to their CDN of choice and registers the URL here
 * with a label + aspect + sort order. Partners see the gallery from
 * `/partner/banners` and download whichever variants they want to
 * share alongside their referral code.
 *
 * Deliberately thin — this iteration only stores the reference. A
 * later phase adds direct-upload endpoints (Cloudinary signed URLs)
 * and click-tracking (banner → unique landing URL → attribution).
 */
export class PartnerBanners_2070000000000 implements MigrationInterface {
  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TYPE partner_banner_aspect_enum AS ENUM (
        'square',
        'story',
        'landscape'
      );
    `);
    await qr.query(`
      CREATE TABLE partner_banners (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        label text NOT NULL,
        description text,
        image_url text NOT NULL,
        aspect partner_banner_aspect_enum NOT NULL DEFAULT 'square',
        width_px int,
        height_px int,
        sort_order int NOT NULL DEFAULT 100,
        is_active boolean NOT NULL DEFAULT true,
        created_by uuid REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await qr.query(`
      CREATE INDEX idx_partner_banners_active_sort
        ON partner_banners (is_active, sort_order);
    `);
  }

  public async down(qr: QueryRunner): Promise<void> {
    await qr.query('DROP INDEX IF EXISTS idx_partner_banners_active_sort;');
    await qr.query('DROP TABLE IF EXISTS partner_banners;');
    await qr.query('DROP TYPE IF EXISTS partner_banner_aspect_enum;');
  }
}
