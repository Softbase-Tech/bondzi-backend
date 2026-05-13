import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `user_devices` for FCM push token registration.
 *
 * Single-device enforcement means a user typically has one active token, but
 * we keep history keyed by (user_id, fcm_token) so a user who reinstalls the
 * app or switches devices doesn't lose the ability to receive pushes while
 * stale tokens age out via FCM's 410/404 response.
 */
export class AddUserDevices_1760000000000 implements MigrationInterface {
  name = 'AddUserDevices_1760000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `create type "user_devices_platform_enum" as enum ('ios','android','web');`,
    );
    await queryRunner.query(`
      create table "user_devices" (
        "id" uuid primary key default gen_random_uuid(),
        "user_id" uuid not null references "users"("id") on delete cascade,
        "platform" "user_devices_platform_enum" not null,
        "fcm_token" text not null,
        "device_id" text,
        "app_version" text,
        "last_seen_at" timestamptz not null default now(),
        "created_at" timestamptz not null default now(),
        constraint "uq_user_devices_user_token" unique ("user_id", "fcm_token")
      );
    `);
    await queryRunner.query(
      `create index "idx_user_devices_user" on "user_devices"("user_id");`,
    );
    await queryRunner.query(
      `create index "idx_user_devices_token" on "user_devices"("fcm_token");`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists "user_devices";`);
    await queryRunner.query(
      `drop type if exists "user_devices_platform_enum";`,
    );
  }
}
