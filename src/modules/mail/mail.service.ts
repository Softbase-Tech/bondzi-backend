import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import {
  BuiltMail,
  MailEvent,
  MailPayloadByEvent,
} from './mail.types';
import { buildWelcomeEmail } from './templates/welcome';
import { buildEmailVerification } from './templates/email-verification';
import { buildPasswordReset } from './templates/password-reset';
import { buildPaymentSuccess } from './templates/payment-success';
import { buildRefundConfirmation } from './templates/refund-confirmation';
import {
  buildSubscriptionCancelled,
  buildSubscriptionExpired,
  buildSubscriptionExpiringSoon,
  buildSubscriptionPaymentFailed,
  buildSubscriptionRenewed,
} from './templates/subscription-events';
import {
  buildLevelUp,
  buildReferralQualified,
  buildStreakAtRisk,
  buildWeeklyDigest,
} from './templates/engagement';

/**
 * Resend-backed transactional mail service.
 *
 * Sends are FIRE-AND-LOG: a failure to send never throws to the caller.
 * Email is best-effort — same contract as push (FirebaseAdminService).
 * A 5xx from Resend, a missing API key, or a malformed template should
 * NOT break a webhook → subscription-activation flow that the user paid
 * money for. Failures are logged and (when Sentry is configured) sent
 * to Sentry for triage.
 *
 * The single-tenant Resend client is shared across calls. When
 * `mail.enabled = false` (dev / test), every send is logged and skipped
 * — no network traffic — and Resend is never initialised.
 *
 * Template dispatch is a typed switch on MailEvent. Adding a new event
 * means: extend MailEvent + MailPayloadByEvent in `mail.types.ts`, add
 * a `buildXxx` function, add a case here. TS will surface the missing
 * case at compile time via the `never` exhaustiveness check at the end.
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private resend: Resend | null = null;
  private from = '';
  private replyTo = '';
  private webUrl = '';
  private enabled = false;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.enabled = this.config.get<boolean>('mail.enabled') ?? false;
    this.from = this.config.get<string>('mail.from') ?? '';
    this.replyTo = this.config.get<string>('mail.replyTo') ?? '';
    this.webUrl = this.config.get<string>('mail.webUrl') ?? '';
    const apiKey = this.config.get<string>('mail.apiKey') ?? '';

    if (!this.enabled) {
      this.logger.log('Mail disabled (MAIL_ENABLED=false) — sends will no-op.');
      return;
    }
    if (!apiKey) {
      this.logger.warn(
        'RESEND_API_KEY not set — sends will no-op even though mail.enabled=true. Set it in production.',
      );
      return;
    }
    this.resend = new Resend(apiKey);
    this.logger.log(`Resend initialised. from=${this.from}`);
  }

  /**
   * Dispatch a transactional email by event type. Payload is type-checked
   * against MailPayloadByEvent so adding a typo / wrong payload at the
   * call site is a compile error.
   *
   * `to` MUST be a valid email — caller is responsible for filtering
   * users without an address before calling. We don't silently drop the
   * send because that hides bugs.
   */
  async send<E extends MailEvent>(
    event: E,
    to: string,
    payload: MailPayloadByEvent[E],
  ): Promise<void> {
    try {
      const built = await this.buildForEvent(event, payload, to);
      if (!this.enabled || !this.resend) {
        this.logger.log(
          `[mail.dry-run] event=${event} to=${redact(to)} subject="${built.subject}" attachments=${built.attachments?.length ?? 0}`,
        );
        return;
      }
      const { error } = await this.resend.emails.send({
        from: this.from,
        to,
        replyTo: this.replyTo,
        subject: built.subject,
        html: built.html,
        text: built.text,
        attachments: built.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
        })),
      });
      if (error) {
        this.logger.error(
          `[mail] Resend rejected event=${event} to=${redact(to)}: ${JSON.stringify(error)}`,
        );
        return;
      }
      this.logger.log(`[mail] sent event=${event} to=${redact(to)}`);
    } catch (err) {
      // Best-effort contract: never throw to the caller. Webhook handlers
      // call this synchronously and we don't want a Resend outage to
      // cascade into a 5xx that makes Paystack retry an already-completed
      // activation.
      this.logger.error(
        `[mail] send failed event=${event} to=${redact(to)}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Type-narrowing template dispatcher. The switch is exhaustive — the
   * trailing `never` cast assignment catches a missing case at compile
   * time when a new MailEvent is added.
   */
  private async buildForEvent<E extends MailEvent>(
    event: E,
    payload: MailPayloadByEvent[E],
    recipientEmail: string,
  ): Promise<BuiltMail> {
    switch (event) {
      case MailEvent.WELCOME:
        return buildWelcomeEmail(
          payload as MailPayloadByEvent[MailEvent.WELCOME],
          this.webUrl,
        );
      case MailEvent.EMAIL_VERIFICATION:
        return buildEmailVerification(
          payload as MailPayloadByEvent[MailEvent.EMAIL_VERIFICATION],
          this.webUrl,
        );
      case MailEvent.PASSWORD_RESET:
        return buildPasswordReset(
          payload as MailPayloadByEvent[MailEvent.PASSWORD_RESET],
          this.webUrl,
        );
      case MailEvent.PAYMENT_SUCCESS:
        return buildPaymentSuccess(
          payload as MailPayloadByEvent[MailEvent.PAYMENT_SUCCESS],
          this.webUrl,
          recipientEmail,
        );
      case MailEvent.REFUND_CONFIRMATION:
        return buildRefundConfirmation(
          payload as MailPayloadByEvent[MailEvent.REFUND_CONFIRMATION],
          this.webUrl,
          recipientEmail,
        );
      case MailEvent.SUBSCRIPTION_RENEWED:
        return buildSubscriptionRenewed(
          payload as MailPayloadByEvent[MailEvent.SUBSCRIPTION_RENEWED],
          this.webUrl,
        );
      case MailEvent.SUBSCRIPTION_EXPIRING_SOON:
        return buildSubscriptionExpiringSoon(
          payload as MailPayloadByEvent[MailEvent.SUBSCRIPTION_EXPIRING_SOON],
          this.webUrl,
        );
      case MailEvent.SUBSCRIPTION_EXPIRED:
        return buildSubscriptionExpired(
          payload as MailPayloadByEvent[MailEvent.SUBSCRIPTION_EXPIRED],
          this.webUrl,
        );
      case MailEvent.SUBSCRIPTION_CANCELLED:
        return buildSubscriptionCancelled(
          payload as MailPayloadByEvent[MailEvent.SUBSCRIPTION_CANCELLED],
          this.webUrl,
        );
      case MailEvent.SUBSCRIPTION_PAYMENT_FAILED:
        return buildSubscriptionPaymentFailed(
          payload as MailPayloadByEvent[MailEvent.SUBSCRIPTION_PAYMENT_FAILED],
          this.webUrl,
        );
      case MailEvent.STREAK_AT_RISK:
        return buildStreakAtRisk(
          payload as MailPayloadByEvent[MailEvent.STREAK_AT_RISK],
          this.webUrl,
        );
      case MailEvent.LEVEL_UP:
        return buildLevelUp(
          payload as MailPayloadByEvent[MailEvent.LEVEL_UP],
          this.webUrl,
        );
      case MailEvent.REFERRAL_QUALIFIED:
        return buildReferralQualified(
          payload as MailPayloadByEvent[MailEvent.REFERRAL_QUALIFIED],
          this.webUrl,
        );
      case MailEvent.WEEKLY_DIGEST:
        return buildWeeklyDigest(
          payload as MailPayloadByEvent[MailEvent.WEEKLY_DIGEST],
          this.webUrl,
        );
      default: {
        // Exhaustiveness: if a new MailEvent literal is added without a
        // case above, TS surfaces it here.
        const exhaustive: never = event;
        throw new Error(`No mail template registered for event: ${exhaustive as string}`);
      }
    }
  }
}

/**
 * Logs preserve the local part of the email but mask everything after
 * the first 2 characters before `@` so production logs aren't a free
 * email-address dump.
 */
function redact(email: string): string {
  const at = email.indexOf('@');
  if (at < 2) return '***';
  return `${email.slice(0, 2)}***${email.slice(at)}`;
}
