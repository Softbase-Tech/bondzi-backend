import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `promo_code_id` to the `subscriptions` table so a successful
 * checkout can record which promo code (if any) was applied at the time
 * the subscription row was created. The redemption ledger entry in
 * `promo_redemptions` references this row via `subscription_id`, but
 * we also want the reverse pointer so:
 *
 *   - the admin entitlement view can show "purchased with code WELCOME20"
 *     without joining promo_redemptions every time;
 *   - the receipt PDF can include the discount line without a second query;
 *   - reconciling a refund knows whether to refund the gross or the net.
 *
 * Nullable because most rows won't have a code attached. Foreign key to
 * `promo_codes(id)` with ON DELETE SET NULL so deleting an unused code
 * doesn't break historic subscription rows.
 */
export class AddPromoCodeIdToSubscriptions_1870000000000
  implements MigrationInterface
{
  name = 'AddPromoCodeIdToSubscriptions_1870000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table "subscriptions"
        add column if not exists "promo_code_id" uuid
        references "promo_codes"("id") on delete set null;
    `);
    await queryRunner.query(`
      create index if not exists "subscriptions_promo_code_idx"
        on "subscriptions" ("promo_code_id")
        where "promo_code_id" is not null;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop index if exists "subscriptions_promo_code_idx";
    `);
    await queryRunner.query(`
      alter table "subscriptions"
        drop column if exists "promo_code_id";
    `);
  }
}
