import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `support_ticket_attachments` — bytes are stored in the DB rather than
 * on disk or in Cloudinary, because:
 *
 *   1. No object-storage infra exists in this project today.
 *   2. Attachments are small (5MB cap × 3 per message) and low-volume
 *      (support tickets — hundreds/month, not thousands). Postgres
 *      bytea comfortably absorbs that.
 *   3. Zero docker-compose changes needed — the api container already
 *      has the DB volume; ephemeral container disk would lose files
 *      on restart.
 *
 * Migration to object storage lands as a data move + one URL rewrite
 * pass when volume outgrows the DB.
 *
 * URL model: capability URL. Anyone who knows the UUID can GET the
 * bytes; the UUID is 128 bits of entropy so effectively unguessable.
 * Acceptable for support content (screenshots the student themselves
 * shared) at this scale; we tighten to signed URLs when we care about
 * unauthorised readers.
 */
export class SupportAttachments_2110000000000 implements MigrationInterface {
  name = 'SupportAttachments_2110000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "support_ticket_attachments" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id"     uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "ticket_id"   uuid NULL REFERENCES "support_tickets"("id") ON DELETE CASCADE,
        "message_id"  uuid NULL REFERENCES "support_ticket_messages"("id") ON DELETE CASCADE,
        "mime"        text NOT NULL,
        "size_bytes"  int  NOT NULL,
        "filename"    text NOT NULL,
        "bytes"       bytea NOT NULL,
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "support_ticket_attachments_size_chk"
          CHECK (size_bytes >= 0 AND size_bytes <= 5242880)
      )
    `);
    // Index for the sweep that deletes orphaned uploads (uploaded but
    // never attached to a message within N hours). Not wired here —
    // the cleanup cron is a follow-up.
    await queryRunner.query(
      `CREATE INDEX "idx_support_ticket_attachments_orphan"
       ON "support_ticket_attachments"("created_at")
       WHERE message_id IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "support_ticket_attachments"`,
    );
  }
}
