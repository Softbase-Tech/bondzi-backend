import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Partner Portal — foundation schema (see /docs/partner-portal-plan.md).
 *
 * Nine tables in one migration because they only make sense together
 * — partners without codes / commissions / payouts / terms is a
 * half-built house. Ordered by FK dependency:
 *
 *   1. partner_terms_versions          (no partner FKs)
 *   2. partners                        (FK terms, FK users)
 *   3. partner_referral_codes          (FK partners)
 *   4. partner_attributions            (FK partners, users, codes)
 *   5. partner_payouts                 (FK partners, users(admin))
 *   6. partner_commissions             (FK partners, users, subs,
 *                                        payouts, terms)
 *   7. partner_signup_credits          (FK partners, users, commissions)
 *   8. partner_fraud_events            (FK partners, users)
 *   9. partner_appeals                 (FK partners, users)
 *
 * Seed inserts the initial terms row so the very first partner
 * registration has a version to attach to. The seeded amounts match
 * the design doc (GHC 30 WASSCE/NOVDEC Plus, GHC 15 BECE Plus,
 * GHC 20 per 10-user batch, GHC 2 answers-bonus at 100 completed
 * answers, 90-day attribution window, 3 fraud flags before block,
 * max 3 appeals).
 */
export class PartnerPortalFoundation_2060000000000 implements MigrationInterface {
  public async up(qr: QueryRunner): Promise<void> {
    // ------------------------------------------------------------------
    // Enums
    // ------------------------------------------------------------------
    await qr.query(`
      CREATE TYPE partner_status_enum AS ENUM (
        'pending','active','suspended','banned'
      );
      CREATE TYPE momo_provider_enum AS ENUM (
        'mtn','airteltigo','telecel','other'
      );
      CREATE TYPE partner_attribution_source_enum AS ENUM (
        'register_code','banner_click_landing','admin_manual'
      );
      CREATE TYPE partner_commission_type_enum AS ENUM (
        'plus_subscription','signup_batch','answers_bonus',
        'plus_subscription_clawback'
      );
      CREATE TYPE partner_commission_status_enum AS ENUM (
        'pending','approved','flagged','clawed_back','paid'
      );
      CREATE TYPE partner_payout_status_enum AS ENUM (
        'pending','paid','failed'
      );
      CREATE TYPE partner_fraud_event_type_enum AS ENUM (
        'attribution_flag','commission_flag','manual'
      );
      CREATE TYPE partner_fraud_severity_enum AS ENUM (
        'low','medium','high'
      );
      CREATE TYPE partner_appeal_status_enum AS ENUM (
        'open','upheld','denied'
      );
    `);

    // ------------------------------------------------------------------
    // 1. partner_terms_versions
    //    Versioned commission-terms document. Every partner points at
    //    the version they agreed to; every commission points at the
    //    version that priced it. Edits INSERT a new row, never UPDATE.
    // ------------------------------------------------------------------
    await qr.query(`
      CREATE TABLE partner_terms_versions (
        id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        version                         int NOT NULL,
        title                           text NOT NULL,
        body_md                         text NOT NULL,
        plus_wassce                     numeric(10,2) NOT NULL,
        plus_novdec                     numeric(10,2) NOT NULL,
        plus_bece                       numeric(10,2) NOT NULL,
        signup_batch_size               int NOT NULL DEFAULT 10,
        signup_batch_amount_ghs         numeric(10,2) NOT NULL DEFAULT 20.00,
        signup_min_completed_answers    int NOT NULL DEFAULT 40,
        answers_bonus_threshold         int NOT NULL DEFAULT 100,
        answers_bonus_amount_ghs        numeric(10,2) NOT NULL DEFAULT 2.00,
        attribution_window_days         int NOT NULL DEFAULT 90,
        max_fraud_flags_before_block    int NOT NULL DEFAULT 3,
        max_appeals                     int NOT NULL DEFAULT 3,
        effective_from                  timestamptz NOT NULL DEFAULT now(),
        created_by                      uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        created_at                      timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX idx_partner_terms_version ON partner_terms_versions (version);
      CREATE INDEX idx_partner_terms_effective ON partner_terms_versions (effective_from DESC);
    `);

    // ------------------------------------------------------------------
    // 2. partners
    //    Partner identity. user_id set when the partner is also a
    //    student (same credentials); nullable so partner-only accounts
    //    can be added in a later phase.
    // ------------------------------------------------------------------
    await qr.query(`
      CREATE TABLE partners (
        id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id                     uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        email                       text NOT NULL,
        phone                       text NOT NULL,
        full_name                   text NOT NULL,
        country_code                text NOT NULL DEFAULT 'GH',
        momo_provider               momo_provider_enum NOT NULL,
        momo_number                 text NOT NULL,
        momo_account_name           text NOT NULL,
        status                      partner_status_enum NOT NULL DEFAULT 'pending',
        agreed_terms_version_id     uuid NOT NULL REFERENCES partner_terms_versions(id),
        fraud_flag_count            int NOT NULL DEFAULT 0,
        approved_at                 timestamptz NULL,
        approved_by                 uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        suspended_at                timestamptz NULL,
        banned_at                   timestamptz NULL,
        created_at                  timestamptz NOT NULL DEFAULT now(),
        updated_at                  timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX idx_partners_email      ON partners (lower(email));
      CREATE UNIQUE INDEX idx_partners_user       ON partners (user_id) WHERE user_id IS NOT NULL;
      CREATE INDEX        idx_partners_status     ON partners (status);
    `);

    // ------------------------------------------------------------------
    // 3. partner_referral_codes
    //    Codes owned by a partner. One default per partner (created at
    //    registration). Codes are globally unique so a student typing
    //    a partner code into the wrong field can't accidentally
    //    resolve — the two lookup tables live in separate namespaces
    //    but the register form enforces the separation by having two
    //    different input fields.
    // ------------------------------------------------------------------
    await qr.query(`
      CREATE TABLE partner_referral_codes (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        partner_id   uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
        code         text NOT NULL,
        label        text NOT NULL DEFAULT 'Default code',
        is_default   boolean NOT NULL DEFAULT false,
        is_active    boolean NOT NULL DEFAULT true,
        created_at   timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX idx_partner_codes_code    ON partner_referral_codes (code);
      CREATE UNIQUE INDEX idx_partner_codes_default ON partner_referral_codes (partner_id) WHERE is_default = true;
      CREATE INDEX        idx_partner_codes_partner ON partner_referral_codes (partner_id);
    `);

    // ------------------------------------------------------------------
    // 4. partner_attributions
    //    Sticky user→partner link. UNIQUE (user_id) means a user is
    //    claimed once, forever. suspicion_flags is an array so all
    //    triggered fraud checks are recorded on one row.
    // ------------------------------------------------------------------
    await qr.query(`
      CREATE TABLE partner_attributions (
        id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id                   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        partner_id                uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
        partner_referral_code_id  uuid NOT NULL REFERENCES partner_referral_codes(id) ON DELETE RESTRICT,
        attribution_source        partner_attribution_source_enum NOT NULL,
        attributed_at             timestamptz NOT NULL DEFAULT now(),
        suspicion_flags           text[] NOT NULL DEFAULT '{}',
        created_by                uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        created_at                timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX idx_partner_attr_user     ON partner_attributions (user_id);
      CREATE INDEX        idx_partner_attr_partner  ON partner_attributions (partner_id);
      CREATE INDEX        idx_partner_attr_code     ON partner_attributions (partner_referral_code_id);
      CREATE INDEX        idx_partner_attr_flags    ON partner_attributions USING gin (suspicion_flags);
    `);

    // ------------------------------------------------------------------
    // 5. partner_payouts
    //    One row per weekly cheque. UNIQUE (partner_id, week_of)
    //    filtered on status prevents two live payouts for the same
    //    week; a failed payout can be retried by inserting a fresh
    //    row.
    // ------------------------------------------------------------------
    await qr.query(`
      CREATE TABLE partner_payouts (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        partner_id         uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
        week_of            date NOT NULL,
        amount_ghs         numeric(10,2) NOT NULL,
        status             partner_payout_status_enum NOT NULL DEFAULT 'pending',
        invoice_number     text NOT NULL,
        invoice_pdf_url    text NULL,
        momo_provider      momo_provider_enum NOT NULL,
        momo_number        text NOT NULL,
        momo_reference     text NULL,
        marked_paid_by     uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        marked_paid_at     timestamptz NULL,
        notes              text NULL,
        created_at         timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX idx_partner_payouts_invoice        ON partner_payouts (invoice_number);
      CREATE UNIQUE INDEX idx_partner_payouts_active_period  ON partner_payouts (partner_id, week_of)
        WHERE status IN ('pending','paid');
      CREATE INDEX        idx_partner_payouts_partner_status ON partner_payouts (partner_id, status);
    `);

    // ------------------------------------------------------------------
    // 6. partner_commissions
    //    The ledger. Every credit lives here. dedup_key + type gives
    //    the DB-level guarantee that the same trigger cannot fire
    //    twice for the same partner.
    // ------------------------------------------------------------------
    await qr.query(`
      CREATE TABLE partner_commissions (
        id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        partner_id           uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
        type                 partner_commission_type_enum NOT NULL,
        amount_ghs           numeric(10,2) NOT NULL,
        currency             text NOT NULL DEFAULT 'GHS',
        status               partner_commission_status_enum NOT NULL DEFAULT 'pending',
        earned_at            timestamptz NOT NULL DEFAULT now(),
        paid_out_id          uuid NULL REFERENCES partner_payouts(id) ON DELETE SET NULL,
        terms_version_id     uuid NOT NULL REFERENCES partner_terms_versions(id),
        subscription_id      uuid NULL REFERENCES subscriptions(id) ON DELETE SET NULL,
        user_id              uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        batch_user_ids       uuid[] NULL,
        flag_reason          text NULL,
        flagged_at           timestamptz NULL,
        dedup_key            text NOT NULL,
        eligibility_meta     jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at           timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX idx_partner_comm_dedup  ON partner_commissions (partner_id, type, dedup_key);
      CREATE INDEX        idx_partner_comm_status ON partner_commissions (partner_id, status);
      CREATE INDEX        idx_partner_comm_payout ON partner_commissions (paid_out_id) WHERE paid_out_id IS NOT NULL;
      CREATE INDEX        idx_partner_comm_earned ON partner_commissions (earned_at DESC);
    `);

    // ------------------------------------------------------------------
    // 7. partner_signup_credits
    //    Pre-batch queue for Stream B. One row per qualified user per
    //    partner. When a partner accumulates 10 with NULL
    //    batched_commission_id, tryClosePartnerBatch pulls them into
    //    a single partner_commissions row.
    // ------------------------------------------------------------------
    await qr.query(`
      CREATE TABLE partner_signup_credits (
        id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        partner_id             uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
        user_id                uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        qualified_at           timestamptz NOT NULL DEFAULT now(),
        batched_commission_id  uuid NULL REFERENCES partner_commissions(id) ON DELETE SET NULL
      );
      CREATE UNIQUE INDEX idx_partner_signup_credits_pu ON partner_signup_credits (partner_id, user_id);
      CREATE INDEX        idx_partner_signup_pending    ON partner_signup_credits (partner_id, qualified_at)
        WHERE batched_commission_id IS NULL;
    `);

    // ------------------------------------------------------------------
    // 8. partner_fraud_events
    //    Every triggered fraud check is logged here. severity + type
    //    drive the auto-block counter on partners.fraud_flag_count.
    // ------------------------------------------------------------------
    await qr.query(`
      CREATE TABLE partner_fraud_events (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        partner_id     uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
        type           partner_fraud_event_type_enum NOT NULL,
        severity       partner_fraud_severity_enum NOT NULL,
        subject_ref    text NULL,
        reason         text NOT NULL,
        detected_at    timestamptz NOT NULL DEFAULT now(),
        resolved       boolean NOT NULL DEFAULT false,
        resolved_by    uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        resolved_at    timestamptz NULL,
        resolution_note text NULL
      );
      CREATE INDEX idx_partner_fraud_partner_open ON partner_fraud_events (partner_id, detected_at DESC)
        WHERE resolved = false;
      CREATE INDEX idx_partner_fraud_severity    ON partner_fraud_events (severity, detected_at DESC);
    `);

    // ------------------------------------------------------------------
    // 9. partner_appeals
    //    Bounded to 3 per partner via UNIQUE (partner_id, appeal_number)
    //    with appeal_number IN (1,2,3). Third denied appeal flips the
    //    partner to `banned` — enforced in the service, not the DB.
    // ------------------------------------------------------------------
    await qr.query(`
      CREATE TABLE partner_appeals (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        partner_id       uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
        appeal_number    int NOT NULL CHECK (appeal_number BETWEEN 1 AND 3),
        opened_at        timestamptz NOT NULL DEFAULT now(),
        body             text NOT NULL,
        attachments      text[] NOT NULL DEFAULT '{}',
        status           partner_appeal_status_enum NOT NULL DEFAULT 'open',
        resolved_at      timestamptz NULL,
        resolved_by      uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        resolution_note  text NULL
      );
      CREATE UNIQUE INDEX idx_partner_appeals_pn ON partner_appeals (partner_id, appeal_number);
      CREATE INDEX        idx_partner_appeals_open ON partner_appeals (status, opened_at DESC)
        WHERE status = 'open';
    `);

    // ------------------------------------------------------------------
    // Initial terms row. Version 1 has the defaults; admin can edit
    // and inserting a new row (via the Terms editor) becomes version 2.
    //
    // The body_md is a load-bearing legal document. This is a first
    // draft to unblock development — expect a lawyer review before the
    // portal opens to real partners.
    // ------------------------------------------------------------------
    await qr.query(`
      INSERT INTO partner_terms_versions (
        version, title, body_md,
        plus_wassce, plus_novdec, plus_bece
      ) VALUES (
        1,
        'Bondzi Partner Programme — Terms & Conditions',
        $$
# Bondzi Partner Programme

Welcome to the Bondzi Partner Programme. By clicking "I agree" during
registration, you accept the terms below.

## 1. Commission structure

- **Plus subscription commission.** When a user attributed to your
  code purchases a Bondzi Plus subscription within 90 days of their
  Bondzi account registration, you earn a one-time commission of
  GHC 30.00 (WASSCE or Nov/Dec Plus) or GHC 15.00 (BECE Plus).
- **Signup batch commission.** For every 10 attributed users who
  each complete exam sessions totalling at least 40 answers, you
  earn GHC 20.00 (GHC 2.00 per user, paid as a batch of 10).
- **Answers bonus.** When an attributed user with an active paid
  Plus subscription completes exam sessions totalling 100+
  answers, you earn a one-time additional GHC 2.00.

Amounts may be revised by Bondzi from time to time; changes only
affect commissions **earned after** the effective date of the new
terms version.

## 2. Attribution

A user is linked to your account when they enter your referral code
at registration, or when they register via a Bondzi landing page
carrying your code cookie. A user can be attributed to only one
partner, permanently.

## 3. Payments

Commissions are paid weekly on Mondays via mobile money to the
number you provide. Payouts follow the completion of the applicable
milestones: Plus commissions pay on the next Monday after the
subscription is confirmed; Signup batches pay on the Monday after
the 10th qualifying user; Answers bonuses pay on the Monday after
the milestone is reached.

You are responsible for reporting your commission earnings to the
Ghana Revenue Authority. Bondzi does not withhold tax.

## 4. Fraud policy

The following are prohibited and will result in suspension or ban:

- **Self-referral** — using your own code on your own account, or on
  an account you control.
- **Device sharing** — registering multiple accounts on a device that
  also hosts your partner account.
- **Wash signups** — creating dummy accounts, bulk-registering with
  synthetic details, or any form of automated signup that does not
  represent a genuine student.
- **Answer scrubbing** — automated or coordinated activity designed
  to make attributed accounts appear to complete exam sessions.

Fraud detection is automated. Each fraud flag lands on your dashboard
and reduces your remaining "strike" allowance. After 3 strikes your
account is suspended.

## 5. Appeals

A suspended partner may open up to 3 appeals. If all 3 are denied,
the account is permanently banned. Banning forfeits all pending
commissions and closes the account. Bondzi's decision on appeals is
final.

## 6. Refunds and clawbacks

If a paid Plus subscription is refunded, chargebacked, or otherwise
reversed, the corresponding commission is clawed back. If already
paid, the amount is deducted from your next payout.

## 7. Termination

You may deactivate your partner account at any time. Bondzi may
terminate the partner relationship with 30 days' notice for any
reason not involving fraud; fraud-related terminations take effect
immediately.
$$::text,
        30.00, 30.00, 15.00
      );
    `);
  }

  public async down(qr: QueryRunner): Promise<void> {
    // Drop in reverse dependency order.
    await qr.query('DROP TABLE IF EXISTS partner_appeals');
    await qr.query('DROP TABLE IF EXISTS partner_fraud_events');
    await qr.query('DROP TABLE IF EXISTS partner_signup_credits');
    await qr.query('DROP TABLE IF EXISTS partner_commissions');
    await qr.query('DROP TABLE IF EXISTS partner_payouts');
    await qr.query('DROP TABLE IF EXISTS partner_attributions');
    await qr.query('DROP TABLE IF EXISTS partner_referral_codes');
    await qr.query('DROP TABLE IF EXISTS partners');
    await qr.query('DROP TABLE IF EXISTS partner_terms_versions');
    await qr.query(`
      DROP TYPE IF EXISTS partner_appeal_status_enum;
      DROP TYPE IF EXISTS partner_fraud_severity_enum;
      DROP TYPE IF EXISTS partner_fraud_event_type_enum;
      DROP TYPE IF EXISTS partner_payout_status_enum;
      DROP TYPE IF EXISTS partner_commission_status_enum;
      DROP TYPE IF EXISTS partner_commission_type_enum;
      DROP TYPE IF EXISTS partner_attribution_source_enum;
      DROP TYPE IF EXISTS momo_provider_enum;
      DROP TYPE IF EXISTS partner_status_enum;
    `);
  }
}
