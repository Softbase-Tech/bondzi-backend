import { randomBytes } from 'crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as Sentry from '@sentry/node';
import { Repository } from 'typeorm';
import { RedisService } from '../../common/redis/redis.service';
import { CacheKeys } from '../../common/utils/cache-keys.util';
import { User } from '../users/entities/user.entity';
import { MailEvent, MailPayloadByEvent } from './mail.types';
import {
  MailSendOptions,
  TRANSACTIONAL_MAIL_EVENTS,
} from './mail-send.options';
import { EmailAuditService } from './email-audit.service';
import { MailQueueService } from './mail-queue.service';
import { buildWelcomeEmail } from './templates/welcome';
import { buildEmailVerification } from './templates/email-verification';
import { buildEmailOtp } from './templates/email-otp';
import { buildPasswordReset } from './templates/password-reset';
import { buildAccountCredited } from './templates/account-credited';
import { buildWinnerAnnouncement } from './templates/winner-announcement';
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
import { Resend } from 'resend';
import { MetricsService } from '../../common/observability/metrics.service';

const VERIFY_TTL_SECONDS = 24 * 60 * 60;
const RESET_TTL_SECONDS = 60 * 60;

@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private resend: Resend | null = null;
  private from = '';
  private replyTo = '';
  private webUrl = '';
  private enabled = false;

  constructor(
    private readonly config: ConfigService,
    private readonly audit: EmailAuditService,
    private readonly queue: MailQueueService,
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {}

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
        'RESEND_API_KEY not set — sends will no-op even though mail.enabled=true.',
      );
      return;
    }
    this.resend = new Resend(apiKey);
    this.logger.log(`Resend initialised. from=${this.from}`);
  }

  getWebUrl(): string {
    return this.webUrl;
  }

  async createEmailVerificationToken(userId: string): Promise<string> {
    const token = randomBytes(32).toString('hex');
    await this.redis.setJson(
      CacheKeys.emailVerifyToken(token),
      { userId },
      VERIFY_TTL_SECONDS,
    );
    return token;
  }

  async consumeEmailVerificationToken(
    token: string,
  ): Promise<{ userId: string } | null> {
    const key = CacheKeys.emailVerifyToken(token);
    const raw = await this.redis.getJson<{ userId: string }>(key);
    if (!raw?.userId) return null;
    await this.redis.del(key);
    return { userId: raw.userId };
  }

  async createPasswordResetToken(userId: string): Promise<string> {
    const token = randomBytes(32).toString('hex');
    await this.redis.setJson(
      CacheKeys.passwordResetToken(token),
      { userId },
      RESET_TTL_SECONDS,
    );
    return token;
  }

  async consumePasswordResetToken(
    token: string,
  ): Promise<{ userId: string } | null> {
    const key = CacheKeys.passwordResetToken(token);
    const raw = await this.redis.getJson<{ userId: string }>(key);
    if (!raw?.userId) return null;
    await this.redis.del(key);
    return { userId: raw.userId };
  }

  buildVerifyUrl(token: string): string {
    const base = this.webUrl.replace(/\/$/, '');
    return `${base}/verify-email?token=${encodeURIComponent(token)}`;
  }

  buildResetUrl(token: string): string {
    const base = this.webUrl.replace(/\/$/, '');
    return `${base}/reset-password?token=${encodeURIComponent(token)}`;
  }

  buildUnsubscribeUrl(token: string): string {
    const base = this.webUrl.replace(/\/$/, '');
    return `${base}/unsubscribe?token=${encodeURIComponent(token)}`;
  }

  /**
   * Dispatch a transactional email. Defaults to sync send; bulk crons pass
   * `sync: false` to route through BullMQ.
   */
  async send<E extends MailEvent>(
    event: E,
    to: string,
    payload: MailPayloadByEvent[E],
    options: MailSendOptions = {},
  ): Promise<void> {
    if (options.sync === false) {
      await this.queue.enqueue(event, to, payload, options);
      return;
    }

    try {
      const skip = await this.shouldSkip(event, to, options);
      if (skip) {
        await this.audit.record({
          userId: options.userId,
          event,
          toEmail: to,
          dedupKey: options.dedupKey,
          status: 'skipped',
          error: skip,
        });
        this.metrics.emailSends.inc({ event, outcome: 'skipped' });
        return;
      }

      if (options.dedupKey) {
        const claimed = await this.audit.tryClaimDedup({
          dedupKey: options.dedupKey,
          userId: options.userId,
          event,
          toEmail: to,
        });
        if (!claimed) {
          this.logger.log(
            `[mail] dedup skip event=${event} key=${options.dedupKey}`,
          );
          this.metrics.emailSends.inc({ event, outcome: 'skipped' });
          return;
        }
      }

      const built = await this.buildForEvent(event, payload, to);
      if (!this.enabled || !this.resend) {
        this.logger.log(
          `[mail.dry-run] event=${event} to=${redact(to)} subject="${built.subject}"`,
        );
        await this.audit.record({
          userId: options.userId,
          event,
          toEmail: to,
          dedupKey: options.dedupKey,
          status: 'dry_run',
        });
        this.metrics.emailSends.inc({ event, outcome: 'dry_run' });
        return;
      }

      const { data, error } = await this.resend.emails.send({
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
        headers: options.idempotencyKey
          ? { 'Idempotency-Key': options.idempotencyKey }
          : undefined,
      });

      if (error) {
        this.logger.error(
          `[mail] Resend rejected event=${event} to=${redact(to)}: ${JSON.stringify(error)}`,
        );
        await this.audit.record({
          userId: options.userId,
          event,
          toEmail: to,
          dedupKey: options.dedupKey,
          status: 'failed',
          error: JSON.stringify(error),
        });
        this.metrics.emailSends.inc({ event, outcome: 'failed' });
        if (process.env.SENTRY_DSN) {
          Sentry.captureMessage(`mail.send failed: ${event}`, {
            level: 'error',
            extra: { to: redact(to), error },
          });
        }
        return;
      }

      await this.audit.record({
        userId: options.userId,
        event,
        toEmail: to,
        dedupKey: options.dedupKey,
        resendId: data?.id,
        status: 'sent',
      });
      this.metrics.emailSends.inc({ event, outcome: 'sent' });
      this.logger.log(`[mail] sent event=${event} to=${redact(to)}`);
    } catch (err) {
      this.logger.error(
        `[mail] send failed event=${event} to=${redact(to)}: ${(err as Error).message}`,
      );
      await this.audit.record({
        userId: options.userId,
        event,
        toEmail: to,
        dedupKey: options.dedupKey,
        status: 'failed',
        error: (err as Error).message,
      });
      this.metrics.emailSends.inc({ event, outcome: 'failed' });
      if (process.env.SENTRY_DSN) {
        Sentry.captureException(err, { extra: { event, to: redact(to) } });
      }
    }
  }

  private async shouldSkip(
    event: MailEvent,
    to: string,
    options: MailSendOptions,
  ): Promise<string | null> {
    if (!options.userId) return null;
    const user = await this.usersRepo.findOne({
      where: { id: options.userId },
      select: [
        'id',
        'emailBouncedAt',
        'emailWeeklyDigestEnabled',
        'emailStreakNudgesEnabled',
        'emailLevelUpEnabled',
        'emailMarketingEnabled',
      ],
    });
    if (!user) return null;
    if (user.emailBouncedAt) return 'recipient_bounced';

    if (TRANSACTIONAL_MAIL_EVENTS.has(event)) return null;

    switch (event) {
      case MailEvent.WEEKLY_DIGEST:
        return user.emailWeeklyDigestEnabled ? null : 'pref_disabled';
      case MailEvent.STREAK_AT_RISK:
        return user.emailStreakNudgesEnabled ? null : 'pref_disabled';
      case MailEvent.LEVEL_UP:
        return user.emailLevelUpEnabled ? null : 'pref_disabled';
      case MailEvent.REFERRAL_QUALIFIED:
        return user.emailMarketingEnabled ? null : 'pref_disabled';
      default:
        return null;
    }
  }

  private async buildForEvent<E extends MailEvent>(
    event: E,
    payload: MailPayloadByEvent[E],
    recipientEmail: string,
  ) {
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
      case MailEvent.EMAIL_OTP:
        return buildEmailOtp(
          payload as MailPayloadByEvent[MailEvent.EMAIL_OTP],
          this.webUrl,
        );
      case MailEvent.PASSWORD_RESET:
        return buildPasswordReset(
          payload as MailPayloadByEvent[MailEvent.PASSWORD_RESET],
          this.webUrl,
        );
      case MailEvent.ACCOUNT_CREDITED:
        return buildAccountCredited(
          payload as MailPayloadByEvent[MailEvent.ACCOUNT_CREDITED],
          this.webUrl,
        );
      case MailEvent.WINNER_ANNOUNCEMENT:
        return buildWinnerAnnouncement(
          payload as MailPayloadByEvent[MailEvent.WINNER_ANNOUNCEMENT],
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
        const exhaustive: never = event;
        throw new Error(
          `No mail template registered for event: ${exhaustive as string}`,
        );
      }
    }
  }
}

function redact(email: string): string {
  const at = email.indexOf('@');
  if (at < 2) return '***';
  return `${email.slice(0, 2)}***${email.slice(at)}`;
}
