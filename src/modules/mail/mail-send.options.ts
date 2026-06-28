import { MailEvent } from './mail.types';

/** Engagement emails honour user preference toggles; transactional do not. */
export const TRANSACTIONAL_MAIL_EVENTS = new Set<MailEvent>([
  MailEvent.WELCOME,
  MailEvent.EMAIL_VERIFICATION,
  // Pre-account OTP for the registration journey. Transactional —
  // the user is mid-signup and unsubscribe / preference toggles
  // don't apply (they don't have an account yet).
  MailEvent.EMAIL_OTP,
  MailEvent.PASSWORD_RESET,
  // Admin grants + winner notifications are account-state changes
  // the user explicitly cares about — they bypass marketing prefs.
  MailEvent.ACCOUNT_CREDITED,
  MailEvent.WINNER_ANNOUNCEMENT,
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
