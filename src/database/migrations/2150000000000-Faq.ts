import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FAQ knowledge base. Powers the "Common questions" surface on the
 * mobile Help hub and the same list on the web (app.bondzi.online).
 *
 * One table:
 *   • faq_entries — one row per Q&A pair. Admin CRUD writes here.
 *     Each row carries a stable slug that becomes the mobile deep-link
 *     path (/help/faq/:slug), the question the student sees on the
 *     list, and the markdown answer rendered on the detail screen.
 *
 * `is_active=false` retires an entry — hidden from mobile without
 * losing history. We soft-delete for the same reason as achievements:
 * a live deep link out in the wild (email, WhatsApp forward) that
 * lands on a 404 reads as broken, whereas a "This answer is no longer
 * available" surface degrades cleanly.
 *
 * Seed data replaces the four inline Alert() FAQ answers on the
 * mobile Help hub with a broader launch-day set covering the top
 * questions from a typical WASSCE/BECE prep support queue. The
 * `slug`s are the ones the mobile client will start deep-linking to
 * on day one, so keep them stable across future migrations.
 */
export class Faq_2150000000000 implements MigrationInterface {
  name = 'Faq_2150000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table if not exists "faq_entries" (
        "id" uuid primary key default gen_random_uuid(),
        "slug" text unique not null,
        "question" text not null,
        "answer_markdown" text not null,
        "sort_order" integer not null default 0,
        "is_active" boolean not null default true,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now()
      );
    `);
    await queryRunner.query(
      `create index if not exists "idx_faq_active_sort" on "faq_entries" ("is_active", "sort_order");`,
    );

    // ─── Seed the launch set ─────────────────────────────────────
    // Ordered by expected support-volume: the "subjects locked" and
    // "XP" questions land first because they're the most-asked
    // during onboarding. Markdown supports bullet lists, bold, and
    // paragraphs — the mobile MathMarkdown renderer already handles
    // this shape (LaTeX is unused here but wouldn't break).
    await queryRunner.query(`
      insert into "faq_entries"
        ("slug","question","answer_markdown","sort_order")
      values
        (
          'why-is-a-subject-locked',
          'Why is a subject locked?',
          $md$**Free** lets you practise your exam's core subjects — Core Mathematics, English, Integrated Science and Social Studies on WASSCE, or your JHS core subjects on BECE.

**Electives** like Physics, Chemistry, Business, Economics and Geography require **Pro**. Every past paper, every quiz, every question — no daily caps.

Open the locked subject and tap **Upgrade** to see the plans. You can also cancel any time from **Settings → Subscription**.$md$,
          10
        ),
        (
          'how-do-i-earn-and-spend-xp',
          'How do I earn and spend XP?',
          $md$You earn **XP** for every correct answer:

- **10 XP** per past-paper question you get right
- **15 XP** per quiz question you get right
- **Bonus XP** when you finish an exam — the bonus scales with your accuracy

You can spend XP from **Profile → Redeem**:

- A month of Pro on your current exam level
- Extra AI explanations
- More rewards as they land

Wrong answers don't cost XP — they just don't earn any.$md$,
          20
        ),
        (
          'what-is-a-streak-and-how-do-i-keep-it',
          'What is a streak and how do I keep it?',
          $md$Your **streak** counts the number of consecutive days you've answered at least one question. Miss a day and the streak resets to 0.

Streaks help build the habit, and after 7 days you unlock **streak XP bonuses** that stack with your regular per-question XP.

If you're at risk of losing a streak, you'll see a **flame reminder** on your Home screen and receive a push notification in the evening (you can turn this off in **Settings → Notifications**).$md$,
          30
        ),
        (
          'can-i-use-bondzi-offline',
          'Can I use Bondzi offline?',
          $md$Not yet — Bondzi needs a connection to load questions and grade answers.

**Offline downloads** are on the roadmap. When it ships you'll be able to save a subject over Wi-Fi and practise it without data. We'll flag it in the app the day it's live.

In the meantime, any answers you send while briefly offline (e.g. tunnels, poor signal) are **queued locally** and submitted the moment your connection returns, so you don't lose XP.$md$,
          40
        ),
        (
          'my-payment-did-not-go-through',
          'My payment didn''t go through',
          $md$Sorry about that. A few common reasons:

- **Insufficient funds** on the card or MoMo wallet
- **Daily transaction limit** hit — try again tomorrow, or use a different card
- **Bank flagged the payment as suspicious** — call your bank; once cleared, retry
- **Network dropped** mid-checkout — the charge usually reverses within 24 hours

If the money **left your account but Pro didn't activate**, open a ticket from **Help → My tickets → New** with your transaction reference and we'll reconcile it manually within 24 hours.$md$,
          50
        ),
        (
          'what-happens-when-my-pro-ends',
          'What happens when my Pro ends?',
          $md$When your subscription ends:

- You keep every answer, XP, streak and unlock you've earned
- Your practice history stays intact
- **Elective subjects lock again** — your progress is preserved for when you renew
- Free-tier daily caps come back (still generous for exam prep)

Nothing is deleted. If you resubscribe later — days, weeks or months on — you pick up exactly where you left off.$md$,
          60
        ),
        (
          'how-do-i-change-my-exam-type',
          'How do I change my exam type?',
          $md$You can switch between **WASSCE**, **BECE** and **NOVDEC** any time from **Settings → Exam type**.

Switching:

- Doesn't reset your XP or streak
- Loads the question pool for the new exam
- Resets your **selected subjects** — you'll pick a fresh set for the new exam

We keep your previous subject picks on file, so switching back later restores them automatically.$md$,
          70
        ),
        (
          'how-do-i-report-a-wrong-question',
          'How do I report a wrong question?',
          $md$Every question has a **flag icon** at the top-right of its screen. Tap it, pick the reason (wrong answer, unclear wording, image broken, etc.), and add a note if you want to.

Reports go straight to our content team. When we correct a question you flagged, you'll receive a notification and — if the fix means your answer was actually right — the XP you missed is credited back.

You can also open a general ticket from **Help → New**.$md$,
          80
        )
      on conflict ("slug") do nothing;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists "faq_entries";`);
  }
}
