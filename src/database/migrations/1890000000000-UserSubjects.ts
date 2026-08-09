import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `user_subjects` — a many-to-many join between users and subjects
 * that records which subjects each user has explicitly opted into
 * studying.
 *
 * **Why this exists.** Before v2.1, subject selection during onboarding
 * was purely informational — the backend filtered questions by
 * `users.exam_type` only, so a WASSCE student saw EVERY WASSCE subject
 * on the home screen whether they cared about them or not. This table
 * makes the selection persistent so the home tab can render only the
 * subjects the student is actually studying (e.g. Maths + English + 3
 * electives), and Settings → Subjects can let them update it later.
 *
 * **Soft-filter contract.** The presence of a row means "user is
 * actively studying this subject"; the ABSENCE of any row for a user
 * means "no preference, show me everything" (fresh accounts default
 * here). Backend question / exam / past-paper queries DO NOT enforce
 * this list — it's a UX hint, not an entitlement gate. That keeps the
 * door open for a student who deselected a subject to still browse it
 * via search or a direct link without forcing them to re-toggle a
 * preference first.
 *
 * **Cascade on delete.** Both FKs cascade — when a user is deleted
 * their rows go too; when a subject is hard-deleted (admin action) the
 * subject is implicitly deselected for every user. The unique
 * `(user_id, subject_id)` index doubles as the natural key for upserts.
 */
export class UserSubjects_1890000000000 implements MigrationInterface {
  name = 'UserSubjects_1890000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table if not exists "user_subjects" (
        "user_id" uuid not null references "users"("id") on delete cascade,
        "subject_id" uuid not null references "subjects"("id") on delete cascade,
        "created_at" timestamptz not null default now(),
        primary key ("user_id", "subject_id")
      );
    `);
    // Lookup by user_id (the hot path: "what does this user study?")
    // is already covered by the primary key — Postgres can use the
    // first column. The reverse direction ("which users study this
    // subject?") is rare; if it becomes a hot path later, add an
    // explicit index on (subject_id) then.
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists "user_subjects";`);
  }
}
