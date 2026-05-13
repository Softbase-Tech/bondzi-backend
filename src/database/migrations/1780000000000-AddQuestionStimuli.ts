import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds shared stimulus support for question groups (pre-ship).
 *
 * Past papers regularly bind 2+ questions to a single context — a table,
 * a passage, a diagram, "Use it to answer Questions 15 and 16". Rather than
 * duplicate the context on every question, a stimulus row is shared across
 * questions via a nullable FK. The mobile renderer detects adjacent
 * questions with the same stimulus_id and shows them as a single group
 * page (stimulus pinned at top, questions stacked below).
 */
export class AddQuestionStimuli_1780000000000 implements MigrationInterface {
  name = 'AddQuestionStimuli_1780000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table "question_stimuli" (
        "id" uuid primary key default gen_random_uuid(),
        "title" text,
        "body" text not null,
        "body_html" text,
        "image_url" text,
        "created_by" uuid references "users"("id") on delete set null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now()
      );
    `);
    await queryRunner.query(
      `create index "idx_question_stimuli_created_at" on "question_stimuli" ("created_at" desc);`,
    );

    await queryRunner.query(
      `alter table "questions" add column "stimulus_id" uuid references "question_stimuli"("id") on delete set null;`,
    );
    // Most exam fetches walk by subject + paper; pulling the stimulus FK
    // alongside is cheap and keeps groups adjacent in indexed scans.
    await queryRunner.query(
      `create index "idx_questions_stimulus" on "questions" ("stimulus_id");`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop index if exists "idx_questions_stimulus";`);
    await queryRunner.query(
      `alter table "questions" drop column if exists "stimulus_id";`,
    );
    await queryRunner.query(
      `drop index if exists "idx_question_stimuli_created_at";`,
    );
    await queryRunner.query(`drop table if exists "question_stimuli" cascade;`);
  }
}
