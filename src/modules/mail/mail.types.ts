/**
 * Transactional email events.
 *
 * Each MailEvent is a single template module under `templates/`. Adding a
 * new event = add a literal to this enum, add a payload interface below,
 * and add the template file. The MailService dispatches by event name —
 * no central registry to maintain.
 */
export enum MailEvent {
  // ----- Account ---------------------------------------------------------
  /** Sent immediately after a user completes registration. */
  WELCOME = 'welcome',
  /** Verify-email link (post-registration or email change). */
  EMAIL_VERIFICATION = 'email_verification',
  /** Time-bounded password-reset link. */
  PASSWORD_RESET = 'password_reset',

  // ----- Payments --------------------------------------------------------
  /** Receipt for a successful Plus or Pro charge. Carries PDF attachment. */
  PAYMENT_SUCCESS = 'payment_success',
  /** Refund confirmation. Carries PDF refund receipt attachment. */
  REFUND_CONFIRMATION = 'refund_confirmation',
  /** Pro subscription renewed on schedule. */
  SUBSCRIPTION_RENEWED = 'subscription_renewed',
  /** Pro subscription expires in N days (cron-triggered reminder). */
  SUBSCRIPTION_EXPIRING_SOON = 'subscription_expiring_soon',
  /** Pro subscription has lapsed past expires_at. */
  SUBSCRIPTION_EXPIRED = 'subscription_expired',
  /** User cancelled their Pro subscription. */
  SUBSCRIPTION_CANCELLED = 'subscription_cancelled',
  /** Paystack renewal charge failed — row flipped to past_due. */
  SUBSCRIPTION_PAYMENT_FAILED = 'subscription_payment_failed',

  // ----- Engagement ------------------------------------------------------
  /** Streak about to break (24h before reset). */
  STREAK_AT_RISK = 'streak_at_risk',
  /** User levelled up (also fires push). Optional email. */
  LEVEL_UP = 'level_up',
  /** A referee just upgraded — congratulate the referrer. */
  REFERRAL_QUALIFIED = 'referral_qualified',
  /** Sunday digest: this week's points, questions answered, rank delta. */
  WEEKLY_DIGEST = 'weekly_digest',
}

// ============================================================================
// Per-event payload shapes
// ----------------------------------------------------------------------------
// Each interface is the parameter object passed to the template's `build()`.
// Keep these small + flat — templates are HTML, not React, so deeply nested
// data has no benefit. Optional fields go last for readability.
// ============================================================================

export interface BasePayload {
  /** Display name for greetings; falls back to "there" if absent. */
  recipientName?: string;
}

export interface WelcomePayload extends BasePayload {
  examType: string; // 'BECE' | 'WASSCE' | 'NOVDEC' (display label)
}

export interface EmailVerificationPayload extends BasePayload {
  verificationUrl: string;
  expiresInMinutes: number;
}

export interface PasswordResetPayload extends BasePayload {
  resetUrl: string;
  expiresInMinutes: number;
  /** IP / region snippet for the "if this wasn't you" footer. */
  requestedFrom?: string;
}

export interface PaymentSuccessPayload extends BasePayload {
  planName: string;
  account: string; // 'Plus' | 'Pro'
  level: string; // 'BECE' | 'WASSCE' | 'NOVDEC' (display label)
  amountDisplay: number; // gross, VAT-inclusive
  currency: string; // 'GHS'
  vatRatePct: number; // e.g. 15
  paidAt: Date;
  reference: string;
  /** For Plus: 'Lifetime'. For Pro: ISO date of next renewal. */
  validUntil: string;
}

export interface RefundConfirmationPayload extends BasePayload {
  planName: string;
  level: string;
  amountDisplay: number;
  currency: string;
  refundedAt: Date;
  reference: string;
}

export interface SubscriptionRenewedPayload extends BasePayload {
  planName: string;
  level: string;
  amountDisplay: number;
  currency: string;
  nextRenewalAt: Date;
  reference: string;
}

export interface SubscriptionExpiringSoonPayload extends BasePayload {
  planName: string;
  level: string;
  expiresAt: Date;
  daysRemaining: number;
}

export interface SubscriptionExpiredPayload extends BasePayload {
  planName: string;
  level: string;
  expiredAt: Date;
}

export interface SubscriptionCancelledPayload extends BasePayload {
  planName: string;
  level: string;
  accessUntil: Date;
}

export interface SubscriptionPaymentFailedPayload extends BasePayload {
  planName: string;
  level: string;
  attemptedAt: Date;
  /** When Paystack will retry (or null if final attempt). */
  nextAttemptAt: Date | null;
}

export interface StreakAtRiskPayload extends BasePayload {
  streakDays: number;
  /** When the streak will reset if no activity. */
  expiresAt: Date;
}

export interface LevelUpPayload extends BasePayload {
  newLevel: number;
  xpEarned: number;
}

export interface ReferralQualifiedPayload extends BasePayload {
  refereeName: string;
  rewardXp: number;
}

export interface WeeklyDigestPayload extends BasePayload {
  questionsAnswered: number;
  correctRate: number; // 0..1
  xpThisWeek: number;
  currentStreak: number;
  rankDelta: number; // +5 / -3
}

/** Map from event → payload type for compile-time checking. */
export interface MailPayloadByEvent {
  [MailEvent.WELCOME]: WelcomePayload;
  [MailEvent.EMAIL_VERIFICATION]: EmailVerificationPayload;
  [MailEvent.PASSWORD_RESET]: PasswordResetPayload;
  [MailEvent.PAYMENT_SUCCESS]: PaymentSuccessPayload;
  [MailEvent.REFUND_CONFIRMATION]: RefundConfirmationPayload;
  [MailEvent.SUBSCRIPTION_RENEWED]: SubscriptionRenewedPayload;
  [MailEvent.SUBSCRIPTION_EXPIRING_SOON]: SubscriptionExpiringSoonPayload;
  [MailEvent.SUBSCRIPTION_EXPIRED]: SubscriptionExpiredPayload;
  [MailEvent.SUBSCRIPTION_CANCELLED]: SubscriptionCancelledPayload;
  [MailEvent.SUBSCRIPTION_PAYMENT_FAILED]: SubscriptionPaymentFailedPayload;
  [MailEvent.STREAK_AT_RISK]: StreakAtRiskPayload;
  [MailEvent.LEVEL_UP]: LevelUpPayload;
  [MailEvent.REFERRAL_QUALIFIED]: ReferralQualifiedPayload;
  [MailEvent.WEEKLY_DIGEST]: WeeklyDigestPayload;
}

/** Returned by every template's `build()` function. */
export interface BuiltMail {
  subject: string;
  html: string;
  /** Plain-text fallback. Optional — falls back to a stripped HTML if absent. */
  text?: string;
  attachments?: MailAttachment[];
}

export interface MailAttachment {
  filename: string;
  /** Raw bytes (e.g. PDF buffer) OR base64 string. */
  content: Buffer | string;
  contentType?: string;
}
