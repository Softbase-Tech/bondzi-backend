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
  /**
   * All 6-digit code emails funnel through this event. The `purpose`
   * inside OtpService.sendEmail namespaces the Redis buckets, and the
   * dedup key on the mail send is purpose-scoped too, but the audit
   * row + Resend send all share this single event name. Three flows
   * ride on it:
   *   - signup           — pre-registration email verification
   *   - email_verify     — post-account "confirm my email"
   *   - password_reset   — email-channel forgot-password
   * Link-based `EMAIL_VERIFICATION` / `PASSWORD_RESET` events were
   * retired here — everything is OTP now.
   */
  EMAIL_OTP = 'email_otp',
  /**
   * Admin manually credited the user with Plus/Pro entitlement.
   * Distinct from PAYMENT_SUCCESS — there's no transaction, no
   * receipt, no Paystack reference; copy explains the grant + how
   * long it lasts.
   */
  ACCOUNT_CREDITED = 'account_credited',
  /**
   * Leaderboard winner notification (weekly / monthly / yearly).
   * Carries the period + rank for personalised copy.
   */
  WINNER_ANNOUNCEMENT = 'winner_announcement',
  /**
   * Internal reminder to the ops mailing list when one or more
   * leaderboard periods are still awaiting winner selection. Fired
   * by WinnerSelectionReminderJob.
   */
  WINNER_SELECTION_REMINDER = 'winner_selection_reminder',

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

  // --- Account lifecycle -------------------------------------------------
  /** Heads-up that the account is scheduled for deletion (T-14 / T-7). */
  ACCOUNT_DELETION_WARNING = 'account_deletion_warning',
  /** Confirmation sent after the account is anonymised. */
  ACCOUNT_DELETED = 'account_deleted',
  /** Daily internal digest of scheduled + deleted accounts (to admins). */
  ADMIN_ACCOUNT_DELETION_DIGEST = 'admin_account_deletion_digest',

  // ----- Partner portal --------------------------------------------------
  /**
   * Sent immediately after a partner submits register — snapshots the
   * agreed commission-terms version so they have a permanent copy of
   * the contract they signed.
   */
  PARTNER_AGREEMENT = 'partner_agreement',
  /**
   * Sent when an admin flips a pending partner to `active`. Contains
   * the partner's default referral code + a link to the partner
   * portal dashboard.
   */
  PARTNER_APPROVED = 'partner_approved',
  /**
   * Sent when an admin marks a payout `paid`. Carries the invoice
   * PDF as an attachment and shows the MoMo reference + amount.
   */
  PARTNER_PAYOUT_PAID = 'partner_payout_paid',
  /**
   * Sent when a partner is suspended — either auto-suspended after
   * their fraud-flag counter crossed the threshold defined in the
   * current terms, or manually suspended by an admin. Explains the
   * appeals process.
   */
  PARTNER_ACCOUNT_SUSPENDED = 'partner_account_suspended',
  /**
   * Sent when a partner is banned — final. Outstanding earnings
   * forfeit, no further payouts.
   */
  PARTNER_ACCOUNT_BANNED = 'partner_account_banned',
  /**
   * Broadcast to all active partners when admin publishes a new
   * terms version. Carries the version number + a diff summary so
   * partners know what changed before opening the full document.
   */
  PARTNER_TERMS_UPDATED = 'partner_terms_updated',
  /**
   * Sent when admin closes an open appeal — upheld (partner
   * reinstated) or denied (strike counter bumps toward the ban
   * threshold).
   */
  PARTNER_APPEAL_RESOLVED = 'partner_appeal_resolved',
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

export interface EmailOtpPayload extends BasePayload {
  /** The 6-digit code rendered prominently in the mail body. */
  code: string;
  expiresInMinutes: number;
}

export interface AccountCreditedPayload extends BasePayload {
  /** 'Plus' or 'Pro' — display label. */
  account: string;
  /** 'BECE' / 'WASSCE' / 'NOVDEC' — display label. */
  level: string;
  /** ISO date of grant expiry, or 'Lifetime' for Plus. */
  validUntil: string;
  /** Free-form note the admin attached at grant time. Optional. */
  adminNote?: string;
}

export interface WinnerAnnouncementPayload extends BasePayload {
  /** 'weekly' | 'monthly' | 'yearly' — grammatical bucket used in copy. */
  period: string;
  /**
   * Specific, dated label for the period this win is for — e.g.
   * "the week of 3–9 Aug 2026" or "August 2026". Anchoring on the
   * actual date matters because awarding lags: a run kicked off on
   * Monday for last week's winners lands after "this week" has
   * rolled over.
   */
  periodLabel: string;
  /** 1-based rank within the period (1 = first place). */
  rank: number;
  /** XP awarded with this win. */
  xpAwarded: number;
  /** Display label of the exam board (BECE / WASSCE / NOVDEC). */
  level: string;
}

export interface WinnerSelectionReminderPayload extends BasePayload {
  /**
   * Periods awaiting selection. The template renders one line
   * per row so the recipient sees exactly what's outstanding.
   * Empty list is a no-op — the job upstream short-circuits in
   * that case and never sends.
   */
  pendingPeriods: Array<{
    examType: string; // 'BECE' | 'WASSCE' | 'NOVDEC' display label
    periodType: string; // 'weekly' | 'monthly' | 'yearly'
    periodStart: string; // YYYY-MM-DD
    candidateCount: number;
  }>;
  /** Absolute URL to the admin /admin/winners page. */
  selectUrl: string;
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
  /**
   * When the user's current prepaid access lapses if all retries
   * fail. Surfaced in the dunning email so the user knows exactly
   * when they'll lose Pro and has a concrete deadline to fix their
   * card.
   */
  accessUntil?: Date | null;
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
  unsubscribeUrl?: string;
}

// ----- Partner portal --------------------------------------------------

export interface PartnerAgreementPayload extends BasePayload {
  partnerName: string;
  /** The referral code that ships with the partner's fresh account. */
  defaultCode: string;
  /** Version number of the terms document the partner just agreed to. */
  termsVersion: number;
  /** Full markdown-rendered terms text — snapshotted at register time. */
  termsBodyMd: string;
  /** Plus commission amounts for the three levels (display strings). */
  plusWassceGhs: string;
  plusNovdecGhs: string;
  plusBeceGhs: string;
  /** GHC amount paid per batch of `signupBatchSize` qualified signups. */
  signupBatchAmountGhs: string;
  signupBatchSize: number;
  signupMinCompletedAnswers: number;
  /** GHC one-off answers-bonus + its threshold. */
  answersBonusAmountGhs: string;
  answersBonusThreshold: number;
  attributionWindowDays: number;
}

export interface PartnerApprovedPayload extends BasePayload {
  partnerName: string;
  defaultCode: string;
  /** Absolute URL to the partner portal home. */
  portalUrl: string;
}

export interface PartnerPayoutPaidPayload extends BasePayload {
  partnerName: string;
  /** GHC amount paid out (already 2dp string, e.g. "80.00"). */
  amountDisplay: string;
  currency: string; // 'GHS'
  /** ISO date of the payout's week_of (usually Monday of pay week). */
  weekOf: string;
  invoiceNumber: string;
  momoProvider: string; // 'MTN' | 'AirtelTigo' | 'Telecel' etc.
  momoNumber: string;
  /** MoMo transfer reference the admin filled in when marking paid. */
  momoReference: string;
  /** Number of individual commissions rolled into this payout. */
  commissionCount: number;
  paidAt: Date;
}

export interface PartnerAccountSuspendedPayload extends BasePayload {
  partnerName: string;
  reason: string;
  /** Absolute URL to the partner portal's appeals page. */
  appealsUrl: string;
  /**
   * How many appeals the partner has remaining before a ban. Nudges
   * them to use their strikes wisely.
   */
  appealsRemaining: number;
}

export interface PartnerAccountBannedPayload extends BasePayload {
  partnerName: string;
  reason: string;
}

export interface PartnerTermsUpdatedPayload extends BasePayload {
  partnerName: string;
  /** New version number now in force. */
  newVersion: number;
  /** Short human-readable summary of what changed (admin authored). */
  changeSummary: string;
  effectiveFrom: Date;
  /** Absolute URL to the terms page inside the partner portal. */
  termsUrl: string;
}

export interface PartnerAppealResolvedPayload extends BasePayload {
  partnerName: string;
  /** 1-based appeal number, matches partner_appeals.appeal_number. */
  appealNumber: number;
  /** 'upheld' → reinstated ; 'denied' → strike, may lead to ban. */
  decision: 'upheld' | 'denied';
  resolutionNote: string | null;
  /**
   * True when this was the third denied appeal and the partner is
   * therefore now banned. Copy switches to the ban notice.
   */
  triggersBan: boolean;
  appealsRemaining: number;
  appealsUrl: string;
}

export interface AccountDeletionWarningPayload extends BasePayload {
  /** Days remaining before deletion (14 or 7). */
  daysLeft: number;
  /** Human-readable date the account will be deleted. */
  deleteOnDate: string;
  /** Drives the copy: was this triggered by inactivity or a user request. */
  reason: 'inactivity' | 'user_requested';
  /** Where to log in to keep the account alive. */
  loginUrl: string;
}

export interface AccountDeletedPayload extends BasePayload {
  /** Human-readable date the account was removed. */
  deletedOnDate: string;
}

export interface AdminAccountDeletionDigestPayload extends BasePayload {
  /** Day the digest covers (YYYY-MM-DD, Accra). */
  dateKey: string;
  scheduledCount: number;
  warnedCount: number;
  deletedCount: number;
  /** A few "reason · masked-email" lines for context. Capped upstream. */
  deletedSamples: string[];
}

/** Map from event → payload type for compile-time checking. */
export interface MailPayloadByEvent {
  [MailEvent.WELCOME]: WelcomePayload;
  [MailEvent.EMAIL_OTP]: EmailOtpPayload;
  [MailEvent.ACCOUNT_CREDITED]: AccountCreditedPayload;
  [MailEvent.WINNER_ANNOUNCEMENT]: WinnerAnnouncementPayload;
  [MailEvent.WINNER_SELECTION_REMINDER]: WinnerSelectionReminderPayload;
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
  [MailEvent.ACCOUNT_DELETION_WARNING]: AccountDeletionWarningPayload;
  [MailEvent.ACCOUNT_DELETED]: AccountDeletedPayload;
  [MailEvent.ADMIN_ACCOUNT_DELETION_DIGEST]: AdminAccountDeletionDigestPayload;
  [MailEvent.PARTNER_AGREEMENT]: PartnerAgreementPayload;
  [MailEvent.PARTNER_APPROVED]: PartnerApprovedPayload;
  [MailEvent.PARTNER_PAYOUT_PAID]: PartnerPayoutPaidPayload;
  [MailEvent.PARTNER_ACCOUNT_SUSPENDED]: PartnerAccountSuspendedPayload;
  [MailEvent.PARTNER_ACCOUNT_BANNED]: PartnerAccountBannedPayload;
  [MailEvent.PARTNER_TERMS_UPDATED]: PartnerTermsUpdatedPayload;
  [MailEvent.PARTNER_APPEAL_RESOLVED]: PartnerAppealResolvedPayload;
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
