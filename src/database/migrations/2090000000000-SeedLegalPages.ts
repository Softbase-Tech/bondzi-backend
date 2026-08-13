import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Seed starter Privacy Policy, Terms of Service, and Account & Data Deletion
 * pages into `legal_pages`. These back the public website routes
 * (/privacy-policy, /terms-of-service, /account-deletion) and the mobile
 * legal viewer, and are editable afterwards from Admin → Legal.
 *
 * ON CONFLICT (slug) DO NOTHING — never overwrites content an admin has
 * already authored, and leaves the partner-used `refund-policy` row alone.
 */
export class SeedLegalPages_2090000000000 implements MigrationInterface {
  name = 'SeedLegalPages_2090000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const pages: Array<{ slug: string; title: string; body: string }> = [
      { slug: 'privacy', title: 'Privacy Policy', body: PRIVACY },
      { slug: 'terms', title: 'Terms of Service', body: TERMS },
      {
        slug: 'account-deletion',
        title: 'Account & Data Deletion',
        body: ACCOUNT_DELETION,
      },
    ];
    for (const p of pages) {
      await queryRunner.query(
        `INSERT INTO "legal_pages" ("slug", "title", "body")
         VALUES ($1, $2, $3)
         ON CONFLICT ("slug") DO NOTHING`,
        [p.slug, p.title, p.body],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Only remove the rows this migration could have created, and only if
    // they still hold the seeded text (don't clobber later admin edits).
    for (const [slug, body] of [
      ['privacy', PRIVACY],
      ['terms', TERMS],
      ['account-deletion', ACCOUNT_DELETION],
    ] as const) {
      await queryRunner.query(
        `DELETE FROM "legal_pages" WHERE "slug" = $1 AND "body" = $2`,
        [slug, body],
      );
    }
  }
}

const LAST_UPDATED = '13 August 2026';

const PRIVACY = `# Privacy Policy

_Last updated: ${LAST_UPDATED}_

Bondzi ("Bondzi", "we", "us") is an exam-preparation service for BECE, WASSCE
and NOV/DEC students in Ghana, operated by Cliffbase Tech. This policy explains
what personal data we collect, how we use it, and the choices you have.

If you have any questions, contact us at **info@bondzi.online**.

## Information we collect

- **Account details** you give us: full name, username, email address, phone
  number, date of birth, gender (optional), exam type, form level and school.
- **Learning activity**: the questions you attempt, scores, streaks, XP, level,
  and progress by subject and topic.
- **Payments**: when you subscribe, payment is processed by **Paystack**. We
  store a record of your transactions (plan, amount, status) but **we never see
  or store your full card or mobile-money credentials**.
- **Device & usage data**: device identifier, app version, and basic technical
  logs used to keep the service secure and reliable.

## How we use your information

- To provide and personalise the service — practice, mock exams, explanations,
  leaderboards and reminders.
- To process subscriptions and referrals.
- To send you account, security and service messages (and, where you've opted
  in, streak nudges and updates — you can turn these off any time).
- To keep Bondzi safe, prevent abuse, and improve our content and features.

## When we share information

We do **not** sell your personal data. We share it only with:

- **Paystack**, to process payments.
- Service providers who help us operate (e.g. email delivery, cloud hosting)
  under confidentiality obligations.
- Authorities where we are legally required to do so.

Leaderboards and the Winners Hall display your **public handle (username)** and
avatar to other students — not your email, phone or real name.

## Data retention and deletion

- We keep your data while your account is active.
- **Inactivity**: if you don't log in for **90 days**, your account is scheduled
  for deletion. We email you before it happens, and simply logging back in
  cancels it.
- **On your request**: you can delete your account any time (see the
  [Account & Data Deletion](/account-deletion) page). There is a 90-day grace
  period during which logging back in restores your account.
- When deletion completes, we **anonymise** your record: your name, email,
  phone, date of birth, avatar and username are removed. Some anonymised or
  aggregated records (e.g. past leaderboard standings) and transaction records
  we are legally required to retain may be kept.

## Your rights

You can access and correct your information from within the app (Profile and
Settings), and you can delete your account as described above. To make any other
request, email **info@bondzi.online**.

## Children and students

Bondzi is intended for students preparing for national exams. If you are under
the age of majority in Ghana, please use Bondzi with the involvement of a parent
or guardian.

## Security

We use industry-standard measures to protect your data. No method of
transmission or storage is completely secure, but we work hard to safeguard your
information and to respond quickly to any issue.

## Changes to this policy

We may update this policy from time to time. We'll revise the "last updated"
date above and, where changes are significant, notify you in the app or by email.

## Contact

Cliffbase Tech · Ghana · **info@bondzi.online**
`;

const TERMS = `# Terms of Service

_Last updated: ${LAST_UPDATED}_

These Terms govern your use of Bondzi, an exam-preparation service operated by
Cliffbase Tech. By creating an account or using Bondzi, you agree to these Terms.

## Eligibility and accounts

- You must provide accurate registration details and keep them up to date.
- You are responsible for activity on your account and for keeping your login
  secure. One account per person.
- We may suspend or restrict accounts that breach these Terms.

## Subscriptions and payments

- Some features require a paid subscription. Prices and what each plan includes
  are shown in the app before you pay.
- Payments are processed by **Paystack**. Refunds are handled under our
  [Refund Policy](/legal/refund-policy).
- Where a subscription renews automatically, you can manage or cancel it from
  the app.

## Acceptable use

You agree **not** to:

- share, sell or transfer your account, or access Bondzi through another
  person's account;
- copy, scrape, resell or redistribute our questions, explanations or other
  content;
- attempt to cheat, manipulate leaderboards or XP, or interfere with the
  service;
- reverse-engineer, disrupt, or attempt to gain unauthorised access to Bondzi.

## Content and intellectual property

Bondzi's questions, explanations, branding and software are owned by us or our
licensors and are provided for your personal, non-commercial exam preparation
only. We grant you a limited, revocable licence to use them for that purpose.

## Leaderboards, XP and fair play

XP, streaks, levels, leaderboards and winner rewards are provided to make
studying engaging. We may adjust, reset or withhold them where we detect abuse
or error.

## Educational disclaimer

Bondzi is a study aid. While we work hard to align with the BECE and WASSCE
syllabi, **we do not guarantee any particular exam result**. Always rely on
official WAEC materials as the definitive source.

## Termination

You may delete your account at any time (see
[Account & Data Deletion](/account-deletion)). We may suspend or terminate
access if you breach these Terms or where required by law.

## Limitation of liability

To the fullest extent permitted by law, Bondzi is provided "as is", and Cliffbase
Tech is not liable for indirect or consequential losses arising from your use of
the service.

## Governing law

These Terms are governed by the laws of the Republic of Ghana.

## Changes

We may update these Terms from time to time; the "last updated" date shows the
latest version. Continued use after changes means you accept them.

## Contact

Cliffbase Tech · Ghana · **info@bondzi.online**
`;

const ACCOUNT_DELETION = `# Account & Data Deletion

_Last updated: ${LAST_UPDATED}_

This page explains how to delete your Bondzi account and what happens to your
data. Bondzi is operated by Cliffbase Tech (**info@bondzi.online**).

## How to delete your account

**In the app (recommended):**

1. Open **Settings → Account**.
2. Tap **Delete account** and confirm.

**On the web:** go to **Settings → Account** and choose **Delete account**.

**If you can't sign in:** email **info@bondzi.online** from the email address on
your account and ask us to delete it. We may ask a question or two to confirm
it's really you before we proceed.

## What happens next

- Your account is **scheduled for deletion** and you're signed out.
- There is a **90-day grace period**. If you change your mind, just **log back
  in before the 90 days are up** and the deletion is cancelled — nothing is lost.
- We email you before the deadline, and again once the account is deleted.
- After 90 days, we permanently **anonymise** your account.

## What data is deleted

We remove your personal information, including your name, email address, phone
number, date of birth, avatar and username.

## What may be retained

- **Anonymised** records that no longer identify you — for example, past
  leaderboard standings — so historical results stay intact.
- **Transaction records** we are required to keep for legal, tax or
  anti-fraud reasons, retained only for as long as the law requires.

## Timeline

Deletion completes **90 days** after you request it (or after 90 days of
inactivity, if your account is dormant), unless you log back in first.

## Contact

Cliffbase Tech · Ghana · **info@bondzi.online**
`;
