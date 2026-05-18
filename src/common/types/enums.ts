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

// v2: exam platform (BECE or WASSCE). First-class across users, subjects, questions, exams.
export enum ExamType {
  BECE = 'bece',
  WASSCE = 'wassce',
}

// v2: school level derived from exam_type (bece→jhs, wassce→shs).
export enum SchoolLevel {
  JHS = 'jhs',
  SHS = 'shs',
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

// v2: added 'xp_credited'.
export enum SubscriptionStatus {
  ACTIVE = 'active',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
  TRIAL = 'trial',
  PAST_DUE = 'past_due',
  XP_CREDITED = 'xp_credited',
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
