/**
 * Central enum registry. Every enum used by entities lives here and is mirrored
 * as a native PostgreSQL enum via TypeORM's @Column({ type: 'enum' }).
 */

export enum UserRole {
  STUDENT = 'student',
  TEACHER = 'teacher',
  ADMIN = 'admin',
  SUPERADMIN = 'superadmin',
}

export enum AuthProvider {
  EMAIL = 'email',
  GOOGLE = 'google',
  PHONE = 'phone',
}

/**
 * Gender collected at registration. Four canonical values mirror the
 * `user_gender_enum` Postgres type (migration 1930). `null` on
 * historical accounts created before the column existed and on any
 * future flow that doesn't ask for it.
 */
export enum Gender {
  MALE = 'male',
  FEMALE = 'female',
  OTHER = 'other',
  PREFER_NOT_TO_SAY = 'prefer_not_to_say',
}

// v2: exam platform. First-class across users, subjects, questions, exams.
// `novdec` (the WAEC re-sit examination for SHS leavers) reuses the WASSCE
// question pool — entitlement filtering happens at the user-level on
// school_level=remedial, not by tagging questions with `novdec`.
export enum ExamType {
  BECE = 'bece',
  WASSCE = 'wassce',
  NOVDEC = 'novdec',
}

/**
 * Resolves an exam type to its question pool. NOVDEC and WASSCE share the
 * same pool — there are no questions/subjects tagged `novdec` in the DB
 * (they'd duplicate the WASSCE catalogue). Use this anywhere you filter
 * questions, subjects, syllabus_topics, exam_sessions, pm_test_questions
 * etc. by the user's exam type.
 *
 * Do NOT use this for:
 *   - leaderboards (NOVDEC users have their own board to keep competition fair)
 *   - entitlements (NOVDEC is its own paid level)
 *   - billing (NOVDEC has its own plan slot)
 */
export function questionPoolFor(examType: ExamType): ExamType {
  return examType === ExamType.NOVDEC ? ExamType.WASSCE : examType;
}

// v2: school level derived from exam_type:
//   bece    → jhs
//   wassce  → shs
//   novdec  → remedial
// `remedial` users have NULL form_level (they aren't in a school cohort).
export enum SchoolLevel {
  JHS = 'jhs',
  SHS = 'shs',
  REMEDIAL = 'remedial',
}

/**
 * Subscription / entitlement account name. The user-visible plan grade.
 *   - `free`: implicit (absence of any active plus/pro entitlement). Never stored.
 *   - `plus`: one-time payment, per-level, lifetime access to past + practice
 *             questions (core + electives) + AI explanations.
 *   - `pro`:  recurring subscription, per-level, everything in plus + curated
 *             AI tests, analytics, weakness assessments.
 * Each entitlement row is scoped to a (user, level) pair — Plus/Pro on SHS
 * does NOT cover BECE or NOVDEC.
 */
export enum AccountType {
  FREE = 'free',
  PLUS = 'plus',
  PRO = 'pro',
}

/**
 * How a plan is paid for. Plus = `one_time` (lifetime grant, no expires_at).
 * Pro = `recurring` (Paystack subscription with billing_interval).
 */
export enum PaymentKind {
  ONE_TIME = 'one_time',
  RECURRING = 'recurring',
}

/**
 * Promo / discount code shape. Percent = e.g. 20% off; fixed = e.g. 50 GHS off
 * (in the plan's currency).
 */
export enum PromoDiscountType {
  PERCENT = 'percent',
  FIXED = 'fixed',
}

/**
 * Audit trail action for admin-driven entitlement changes (manual grant /
 * revoke / extend). Excludes user-initiated purchases — those are captured
 * via the existing `financial_events` table.
 */
export enum EntitlementAuditAction {
  GRANT = 'grant',
  REVOKE = 'revoke',
  EXTEND = 'extend',
  REFUND = 'refund',
}

export enum SubjectCategory {
  CORE = 'core',
  ELECTIVE = 'elective',
  VOCATIONAL = 'vocational',
}

export enum QuestionType {
  MCQ = 'mcq',
  TRUE_FALSE = 'true_false',
  FILL_BLANK = 'fill_blank',
  ESSAY = 'essay',
  STRUCTURED = 'structured',
}

// v2: reduced to three sources — past papers (per exam) + AI-generated PassMaster Test.
export enum QuestionSource {
  WASSCE_PAST = 'wassce_past',
  BECE_PAST = 'bece_past',
  AI_PASSMASTER_TEST = 'ai_passmaster_test',
}

export enum QuestionStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  PENDING_REVIEW = 'pending_review',
  ARCHIVED = 'archived',
}

// v2: which pool a question lives in — used on exam_answers, srs_cards, question_flags
// to discriminate between past-paper questions and AI-generated PM Test questions.
export enum QuestionPool {
  PAST_PAPER = 'past_paper',
  PM_TEST = 'pm_test',
}

export enum Difficulty {
  EASY = 'easy',
  MEDIUM = 'medium',
  HARD = 'hard',
}

export enum ExplanationSource {
  AI_CLAUDE = 'ai_claude',
  AI_GPT = 'ai_gpt',
  HUMAN_EDITOR = 'human_editor',
  TEACHER = 'teacher',
}

// v2: exam modes — aligned with product spec.
export enum ExamMode {
  PAST_PAPER = 'past_paper',
  PRACTICE = 'practice',
  TOPIC_DRILL = 'topic_drill',
  PM_TEST = 'pm_test',
  SRS_REVIEW = 'srs_review',
}

export enum ExamStatus {
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  ABANDONED = 'abandoned',
  PAUSED = 'paused',
}

/**
 * Billing cadence on a subscription row. One plan offers all three — the user
 * picks a cadence at checkout. XP-credited subscriptions have
 * billing_interval = NULL (they aren't paid billings).
 */
export enum BillingInterval {
  MONTHLY = 'monthly',
  SIX_MONTH = 'six_month',
  ANNUAL = 'annual',
}

// Subscription state machine.
//
//   ACTIVE      — currently entitled. Renews on its own (Pro) or is
//                 lifetime (Plus, expires_at=null).
//   CANCELLED   — user tapped Cancel. expires_at is preserved; the
//                 entitlement resolver still grants access until that
//                 date (cancellation grace). After expires_at lapses
//                 the renewal cron flips it to EXPIRED.
//   EXPIRED     — terminal "natural end": prepaid period ran out, or
//                 Paystack gave up on recurring renewal retries.
//                 Row kept for audit; no access.
//   REFUNDED    — refund landed. Access removed immediately.
//   XP_CREDITED — granted via XP redemption rather than payment.
//                 Lives in the active set for resolution purposes.
//
// `TRIAL`, `PAST_DUE`, and `INACTIVE` are LEGACY — kept in the enum so
// older test rows don't blow up TypeORM but never written by current
// application code. The 1900-PaymentsAndBillingLog migration backfilled
// any existing rows in those states to EXPIRED. The payments table is now
// the source of truth for "checkout attempted, not yet paid" and the
// `subscription.disable` webhook is what flips a Pro subscription to
// EXPIRED when Paystack gives up on retries.
export enum SubscriptionStatus {
  ACTIVE = 'active',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
  /** @deprecated never write — see header comment. */
  TRIAL = 'trial',
  /** @deprecated never write — see header comment. */
  PAST_DUE = 'past_due',
  /** @deprecated never write — see header comment. */
  INACTIVE = 'inactive',
  XP_CREDITED = 'xp_credited',
  REFUNDED = 'refunded',
}

/**
 * Payment-attempt lifecycle. Owned by the `payment_attempts` table.
 *
 *   PENDING   — initiated by the backend, Paystack URL handed to the
 *               client. We're waiting for either the mobile verify
 *               callback or the server-to-server webhook to confirm.
 *   PAID      — webhook (or verify) confirmed the charge. `paid_at`
 *               is stamped. A subscription row will exist alongside.
 *   FAILED    — Paystack explicitly told us the charge failed (card
 *               declined, insufficient funds, etc.). Terminal.
 *   REFUNDED  — original charge was paid then refunded out-of-band.
 *               The linked subscription is also flipped to REFUNDED.
 *   ABANDONED — swept from PENDING after the abandon window
 *               (default 24h). Cosmetic distinction from "still
 *               waiting for a webhook" so admins don't have to wonder.
 */
export enum PaymentAttemptStatus {
  PENDING = 'pending',
  PAID = 'paid',
  FAILED = 'failed',
  REFUNDED = 'refunded',
  ABANDONED = 'abandoned',
}

/**
 * Outcome of processing a single webhook event. Recorded on the
 * `billing_log` row so the admin "Webhooks" view can surface
 * `no_matching_payment` events as security alarms.
 *
 *   RECEIVED            — row written, downstream processing pending.
 *   SUCCESS             — downstream processing applied cleanly.
 *   NO_MATCHING_PAYMENT — webhook reference didn't match any
 *                         payment_attempts row. Potential fraud /
 *                         misrouted webhook. ALARM.
 *   DUPLICATE           — same provider_event_id was processed before.
 *                         Idempotent no-op; logged for audit.
 *   ERROR               — processing threw. `process_error` carries
 *                         the message. Requires manual reconciliation.
 */
export enum BillingLogProcessStatus {
  RECEIVED = 'received',
  SUCCESS = 'success',
  NO_MATCHING_PAYMENT = 'no_matching_payment',
  DUPLICATE = 'duplicate',
  ERROR = 'error',
}

export enum FlagReason {
  WRONG_ANSWER = 'wrong_answer',
  TYPO = 'typo',
  BAD_IMAGE = 'bad_image',
  OUTDATED = 'outdated',
  DUPLICATE = 'duplicate',
  OTHER = 'other',
}

export enum NotificationChannel {
  PUSH = 'push',
  SMS = 'sms',
  WHATSAPP = 'whatsapp',
  IN_APP = 'in_app',
}

export enum SchoolRole {
  STUDENT = 'student',
  TEACHER = 'teacher',
  ADMIN = 'admin',
}

export enum AiAction {
  EXPLANATION = 'explanation',
  HINT = 'hint',
  CHAT_TUTOR = 'chat_tutor',
  QUESTION_GEN = 'question_gen',
  MODERATION = 'moderation',
}

// v2: admin-triggered AI job lifecycle.
export enum AiJobType {
  EXPLANATION_BULK = 'explanation_bulk',
  PM_TEST_GENERATION = 'pm_test_generation',
}

export enum AiJobStatus {
  // Held awaiting a second admin's approval because estimated cost
  // exceeds AI_COSIGN_THRESHOLD_USD. NOT enqueued for processing.
  PENDING_APPROVAL = 'pending_approval',
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

// v2: leaderboard period (weekly or monthly).
export enum LeaderboardPeriodType {
  WEEKLY = 'weekly',
  MONTHLY = 'monthly',
}

/**
 * Entitlement service registry — every gated capability in the app has
 * exactly one key here. The tier × service matrix in
 * `tier_services` reads from this list, and the `@RequiresService`
 * guard names one of these values.
 *
 * Adding a new gated feature = add the key here + one row per tier in
 * the seed migration + decorate the controller method. Removing a key
 * requires a migration to drop the corresponding tier_services rows.
 *
 * Notes on the current membership:
 *   • PAST_PAPERS_CORE / PAST_PAPERS_ELECTIVE — the split lets Free
 *     get all core subjects but only a metered number of electives.
 *   • POST_EXAM_AI_BREAKDOWN — slot reserved but the generation
 *     feature is deferred. Seeded `enabled=false` in every tier so
 *     enabling later is one row update, not a code change.
 *   • MOCK_EXAMS — Quiz-tab rescope; endpoint / template loader
 *     lands in Phase 2.3.
 */
export enum EntitlementService {
  PAST_PAPERS_CORE = 'past_papers_core',
  PAST_PAPERS_ELECTIVE = 'past_papers_elective',
  LEVEL_TESTS = 'level_tests',
  MOCK_EXAMS = 'mock_exams',
  AI_EXPLANATIONS = 'ai_explanations',
  POST_EXAM_AI_BREAKDOWN = 'post_exam_ai_breakdown',
  AI_WEAKNESS_NARRATIVES = 'ai_weakness_narratives',
}
