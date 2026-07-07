import { MailEvent } from './mail.types';

/** Engagement emails honour user preference toggles; transactional do not. */
export const TRANSACTIONAL_MAIL_EVENTS = new Set<MailEvent>([
  MailEvent.WELCOME,
  // Every 6-digit code email — signup, email verification, and
  // password reset — funnels through EMAIL_OTP. All transactional:
  // unsubscribe / preference toggles don't apply because the user is
  // either pre-account (signup) or actively trying to prove they
  // control the address (verify / reset).
  MailEvent.EMAIL_OTP,
  // Admin grants + winner notifications are account-state changes
  // the user explicitly cares about — they bypass marketing prefs.
  MailEvent.ACCOUNT_CREDITED,
  MailEvent.WINNER_ANNOUNCEMENT,
  // Internal ops reminder — sent to a hardcoded mailing list, not
  // to end users; preference toggles don't apply.
  MailEvent.WINNER_SELECTION_REMINDER,
  MailEvent.PAYMENT_SUCCESS,
  MailEvent.REFUND_CONFIRMATION,
  MailEvent.SUBSCRIPTION_RENEWED,
  MailEvent.SUBSCRIPTION_EXPIRING_SOON,
  MailEvent.SUBSCRIPTION_EXPIRED,
  MailEvent.SUBSCRIPTION_CANCELLED,
  MailEvent.SUBSCRIPTION_PAYMENT_FAILED,
]);

export interface MailSendOptions {
  userId?: string;
  /** Unique per logical send — prevents cron duplicate blasts. */
  dedupKey?: string;
  /** Resend idempotency key — prevents webhook-retry duplicate receipts. */
  idempotencyKey?: string;
  /** Skip BullMQ and send inline (default for transactional hot paths). */
  sync?: boolean;
}

export interface QueuedMailJob {
  event: MailEvent;
  to: string;
  payload: Record<string, unknown>;
  options?: MailSendOptions;
}
