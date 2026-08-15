import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `support_tickets` + `support_ticket_messages` — the ticket system
 * students use to reach us for feedback, wrong-question reports,
 * payment issues, and general enquiries. Replaces the earlier
 * WhatsApp-only flow.
 *
 * Design decisions:
 *   - Human-readable ticket number (BQ-YYMM-NNNN) that students can
 *     reference in follow-ups. Server-generated via a per-month
 *     sequence so numbers are dense within a month.
 *   - Attachments live as a jsonb array of {url, mime, sizeBytes} so
 *     we can extend to metadata (thumbnail, original filename) without
 *     another migration.
 *   - Only admins close tickets. When they do we record who and why.
 *     A user cannot post messages onto a closed ticket — enforced in
 *     service code (this migration doesn't add a CHECK constraint
 *     since re-opening for exceptional cases needs to stay possible).
 *   - senderRole on messages ('user' | 'admin') is denormalised so the
 *     ticket detail render doesn't have to re-lookup roles per row.
 *   - Category is a text enum via CHECK — cheap and doesn't need an
 *     enum type alter cycle when we add categories later.
 */
export class SupportTickets_2100000000000 implements MigrationInterface {
  name = 'SupportTickets_2100000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Tickets ----------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "support_tickets" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "ticket_number"   text NOT NULL UNIQUE,
        "user_id"         uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "category"        text NOT NULL,
        "subject"         text NOT NULL,
        "status"          text NOT NULL DEFAULT 'open',
        "related_ticket_number" text NULL,
        "context"         jsonb NULL,
        "closed_at"       timestamptz NULL,
        "closed_by"       uuid NULL REFERENCES "users"("id") ON DELETE SET NULL,
        "closed_reason"   text NULL,
        "last_reply_at"   timestamptz NOT NULL DEFAULT now(),
        "last_reply_by"   text NOT NULL DEFAULT 'user',
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "updated_at"      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "support_tickets_category_chk" CHECK (
          category IN ('feedback', 'wrong_question', 'payment', 'general')
        ),
        CONSTRAINT "support_tickets_status_chk" CHECK (
          status IN ('open', 'closed')
        ),
        CONSTRAINT "support_tickets_last_reply_by_chk" CHECK (
          last_reply_by IN ('user', 'admin')
        )
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_support_tickets_user_id" ON "support_tickets"("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_support_tickets_status" ON "support_tickets"("status")`,
    );
    // Admin queue orders by open + oldest-last-reply; helps that scan.
    await queryRunner.query(
      `CREATE INDEX "idx_support_tickets_queue" ON "support_tickets"("status","last_reply_at" DESC)`,
    );

    // Per-month sequence for ticket-number generation. Named
    // BQ-YYMM-NNNN in the service; the sequence provides the NNNN.
    // A single sequence is fine at our volume (< 10k/month).
    await queryRunner.query(`
      CREATE SEQUENCE IF NOT EXISTS "support_tickets_number_seq"
    `);

    // Messages ---------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "support_ticket_messages" (
        "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "ticket_id"    uuid NOT NULL REFERENCES "support_tickets"("id") ON DELETE CASCADE,
        "sender_id"    uuid NULL REFERENCES "users"("id") ON DELETE SET NULL,
        "sender_role"  text NOT NULL,
        "body"         text NOT NULL,
        "attachments"  jsonb NOT NULL DEFAULT '[]'::jsonb,
        "created_at"   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "support_ticket_messages_sender_role_chk" CHECK (
          sender_role IN ('user', 'admin', 'system')
        )
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_support_ticket_messages_ticket_id" ON "support_ticket_messages"("ticket_id","created_at" ASC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "support_ticket_messages"`);
    await queryRunner.query(`DROP SEQUENCE IF EXISTS "support_tickets_number_seq"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "support_tickets"`);
  }
}
