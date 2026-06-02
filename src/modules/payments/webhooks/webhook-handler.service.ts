import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AccountType,
  PaymentKind,
  SubscriptionStatus,
} from '../../../common/types/enums';
import { PlansService } from '../../subscriptions/plans/plans.service';
import { SubscriptionsService } from '../../subscriptions/subscriptions.service';
import { PaymentEvent } from '../entities/payment-event.entity';
import { FinancialEventType } from '../entities/financial-event.entity';
import { FinancialAuditService } from '../financial-audit.service';
import { NormalizedWebhookEvent } from '../providers/payment-provider.interface';
import { MailService } from '../../mail/mail.service';
import { MailEvent } from '../../mail/mail.types';
import { User } from '../../users/entities/user.entity';
import { SubscriptionPlanEntity } from '../../subscriptions/plans/entities/subscription-plan.entity';

/**
 * Provider-agnostic webhook processor. Idempotency + event persistence +
 * side effects on the subscription row live here. Signature verification
 * and parsing happen earlier, in the per-provider controller entrypoint.
 *
 * Idempotency + retry contract (spec §5.8 — revised):
 *
 *  1. Try to insert a `payment_events` row keyed by (provider, event_id).
 *     If the row already exists AND `processed=true`, the event is a true
 *     duplicate — return immediately so the controller responds 200.
 *  2. Otherwise (fresh row OR existing row with `processed=false`), run
 *     `dispatch(event)`.
 *  3. On success, flip `processed=true`.
 *  4. On failure, persist the error message AND THROW. The controller
 *     re-throws so the HTTP layer returns 5xx, the provider retries
 *     according to its policy, and a separate reconciliation job (TODO,
 *     see WebhookReconciliationJob in jobs/) can re-process anything
 *     stuck with `processed=false` past a grace window.
 *
 * The previous behaviour silently returned 200 on processing failure;
 * Paystack would never retry, the row stayed `processed=false`, and the
 * customer paid with no premium granted. This was the single largest
 * revenue-loss bug in the system.
 */
/**
 * Reject webhooks whose provider-claimed timestamp is older than this
 * many milliseconds. Defends against capture-and-replay: an attacker who
 * recorded a body + HMAC last year can't replay it tomorrow because the
 * embedded `paid_at` is in the past beyond the window. We accept future-
 * dated events up to the same window in case provider/our clock drifts.
 * 7 days is conservative: Paystack's own retry window is up to 72h, so
 * legitimately-delayed events still fit.
 */
const WEBHOOK_FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class WebhookHandlerService {
  private readonly logger = new Logger(WebhookHandlerService.name);

  constructor(
    @InjectRepository(PaymentEvent)
    private readonly eventsRepo: Repository<PaymentEvent>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    private readonly subs: SubscriptionsService,
    private readonly plans: PlansService,
    private readonly financialAudit: FinancialAuditService,
    private readonly mail: MailService,
  ) {}

  async process(
    provider: string,
    event: NormalizedWebhookEvent,
  ): Promise<{ duplicate: boolean; processed: boolean }> {
    // Freshness gate: reject events whose claimed timestamp is too far
    // from "now" in either direction. The signed body's paid_at/created_at
    // is part of the HMAC envelope so an attacker can't tamper with it
    // without invalidating the signature. Without this, a captured event
    // from before the payment_events table was migrated could replay
    // freely once and become "processed". We treat the gate as a
    // hard reject (drop the event) but log loudly so admins notice if
    // legitimate deliveries are arriving stale.
    if (event.claimedAt) {
      const drift = Math.abs(Date.now() - event.claimedAt.getTime());
      if (drift > WEBHOOK_FRESHNESS_WINDOW_MS) {
        this.logger.warn(
          `[webhook] stale event ${provider}:${event.eventId} claimedAt=${event.claimedAt.toISOString()} drift=${Math.round(drift / 1000)}s — rejecting`,
        );
        return { duplicate: false, processed: false };
      }
    }
    let existing: PaymentEvent | null = null;
    try {
      await this.eventsRepo.save(
        this.eventsRepo.create({
          provider,
          providerEventId: event.eventId,
          eventType: event.type,
          rawPayload: event.raw,
          processed: false,
        }),
      );
    } catch (err) {
      if (!this.isUniqueViolation(err)) throw err;
      existing = await this.eventsRepo.findOne({
        where: { provider, providerEventId: event.eventId },
      });
      // Truly already processed → safe to skip and respond 200.
      if (existing?.processed) {
        this.logger.log(
          `[webhook] duplicate event ${provider}:${event.eventId} — already processed, skipping`,
        );
        return { duplicate: true, processed: false };
      }
      // Row exists but processing previously failed (or is in-flight from
      // a near-simultaneous delivery). Fall through and try again.
      this.logger.log(
        `[webhook] retrying unprocessed event ${provider}:${event.eventId}`,
      );
    }

    try {
      await this.dispatch(event);
      await this.eventsRepo.update(
        { provider, providerEventId: event.eventId },
        { processed: true, processedAt: new Date(), error: null },
      );
      return { duplicate: Boolean(existing), processed: true };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(
        `[webhook] processing ${event.type} failed (will retry): ${message}`,
      );
      await this.eventsRepo
        .update(
          { provider, providerEventId: event.eventId },
          { error: message },
        )
        .catch((updateErr) =>
          this.logger.error(
            `[webhook] failed to persist error on event row: ${(updateErr as Error).message}`,
          ),
        );
      // Re-throw so the controller responds 5xx → provider retries → next
      // delivery hits the duplicate branch above and re-attempts dispatch.
      throw new ServiceUnavailableException({
        code: 'WEBHOOK_PROCESSING_FAILED',
        message: 'Webhook processing failed; provider should retry.',
      });
    }
  }

  private async dispatch(event: NormalizedWebhookEvent): Promise<void> {
    switch (event.type) {
      case 'charge.success':
        return this.onChargeSuccess(event);
      case 'subscription.create':
        return this.onSubscriptionCreate(event);
      case 'subscription.disable':
        return this.onStatusChange(event, SubscriptionStatus.CANCELLED);
      case 'subscription.not_renew':
        return this.onSubscriptionNotRenew(event);
      case 'invoice.failed':
        return this.onStatusChange(event, SubscriptionStatus.PAST_DUE);
      case 'invoice.update':
        return this.onInvoiceUpdate(event);
      case 'refund.processed':
        return this.onRefundProcessed(event);
      case 'unknown':
      default:
        this.logger.warn(`[webhook] unhandled event: ${event.type}`);
    }
  }

  private async onChargeSuccess(event: NormalizedWebhookEvent): Promise<void> {
    const userId = await this.resolveUserId(event);
    if (!userId) {
      this.logger.warn(
        `[webhook] charge.success with no resolvable user (ref=${event.reference})`,
      );
      return;
    }

    const plan = await this.resolvePlan(event);
    if (!plan) {
      this.logger.warn(
        `[webhook] charge.success with no matching plan (code=${event.providerPlanCode})`,
      );
      return;
    }

    // One-time (Plus) plans have no provider plan code and no interval —
    // they're charged as a single Paystack transaction. The catalogue's
    // `payment_kind` is the source of truth; the absence of a plan code
    // alone isn't reliable (Pro charges can momentarily lack one if
    // Paystack hasn't echoed it back yet).
    const isOneTime = plan.paymentKind === PaymentKind.ONE_TIME;
    const interval = isOneTime
      ? null
      : event.providerPlanCode
        ? this.plans.intervalForProviderPlanCode(plan, event.providerPlanCode)
        : null;
    if (!isOneTime && !interval) {
      this.logger.warn(
        `[webhook] charge.success could not infer billing interval for recurring plan=${plan.id}`,
      );
      return;
    }

    const amountDisplay =
      event.amountMinor !== undefined ? event.amountMinor / 100 : undefined;

    await this.subs.applyWebhookActivation({
      userId,
      plan,
      interval,
      providerReference: event.reference,
      providerCustomerId: event.customerId,
      // One-time charges never have a Paystack subscription id (Paystack
      // only mints one for recurring plans). Pass undefined so we don't
      // stamp a null over an existing value on a duplicate webhook.
      providerSubscriptionId: isOneTime ? undefined : event.subscriptionId,
      amountDisplay,
    });
    await this.financialAudit.record({
      eventType: FinancialEventType.ACTIVATION,
      userId,
      amountMinor: event.amountMinor ?? null,
      currency: event.currency ?? null,
      source: 'webhook',
      metadata: {
        provider: 'paystack',
        providerEventId: event.eventId,
        providerReference: event.reference,
        providerPlanCode: event.providerPlanCode,
        planId: plan.id,
        // `null` for one-time; the cadence string ('monthly' / 'annual' /
        // ...) for recurring. Recorded so reconciliation/forensics can
        // distinguish Plus vs Pro from the audit trail alone.
        interval,
        account: plan.account,
        level: plan.level,
        paymentKind: plan.paymentKind,
      },
    });

    // Receipt email. Best-effort — MailService never throws on failure
    // so a Resend hiccup can't roll back an activation. The PDF receipt
    // is built inside the template (uses the same VAT-inclusive math
    // the catalogue stores).
    await this.dispatchPaymentReceiptEmail(userId, plan, event, amountDisplay);
  }

  private async dispatchPaymentReceiptEmail(
    userId: string,
    plan: SubscriptionPlanEntity,
    event: NormalizedWebhookEvent,
    amountDisplay: number | undefined,
  ): Promise<void> {
    if (amountDisplay === undefined || !event.reference) return;
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user?.email) {
      this.logger.warn(
        `[mail] cannot send payment receipt to user=${userId} — no email on file`,
      );
      return;
    }
    const validUntil = await this.computeValidUntil(plan, event);
    await this.mail.send(MailEvent.PAYMENT_SUCCESS, user.email, {
      recipientName: user.fullName ?? undefined,
      planName: plan.name,
      account: accountLabel(plan.account),
      level: plan.level.toUpperCase(),
      amountDisplay,
      currency: event.currency ?? plan.currency,
      vatRatePct: Number(plan.vatRatePct) || 0,
      paidAt: event.claimedAt ?? new Date(),
      reference: event.reference,
      validUntil,
    });
  }

  /**
   * For Plus (one-time) the receipt shows "Lifetime"; for Pro
   * (recurring) it shows the human-readable renewal date pulled from
   * the freshly-activated subscription row.
   */
  private async computeValidUntil(
    plan: SubscriptionPlanEntity,
    event: NormalizedWebhookEvent,
  ): Promise<string> {
    if (plan.paymentKind === PaymentKind.ONE_TIME) return 'Lifetime';
    if (!event.reference) return 'Until next renewal';
    const sub = await this.subs.findLatestByRef(event.reference);
    if (sub?.expiresAt) {
      return sub.expiresAt.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
    }
    return 'Until next renewal';
  }

  private async onSubscriptionCreate(
    event: NormalizedWebhookEvent,
  ): Promise<void> {
    if (!event.subscriptionId || !event.customerId) return;
    const sub = await this.subs.findLatestByCustomer(event.customerId);
    if (!sub) {
      this.logger.warn(
        `[webhook] subscription.create with no matching subscription row (customer=${event.customerId})`,
      );
      return;
    }
    sub.providerSubscriptionId = event.subscriptionId;
    await this.subs.saveSubscription(sub);
    await this.subs.invalidateCache(sub.userId);
  }

  private async onStatusChange(
    event: NormalizedWebhookEvent,
    status: SubscriptionStatus,
  ): Promise<void> {
    if (!event.subscriptionId) return;
    const sub = await this.subs.findLatestBySubscriptionId(
      event.subscriptionId,
    );
    if (!sub) return;
    sub.status = status;
    await this.subs.saveSubscription(sub);
    await this.subs.invalidateCache(sub.userId);
    await this.financialAudit.record({
      eventType:
        status === SubscriptionStatus.CANCELLED
          ? FinancialEventType.CANCELLATION
          : FinancialEventType.STATUS_CORRECTION,
      userId: sub.userId,
      subscriptionId: sub.id,
      source: 'webhook',
      metadata: {
        provider: 'paystack',
        providerEventId: event.eventId,
        newStatus: status,
      },
    });

    // Renewal-failed nudge: Paystack maps `invoice.failed` → PAST_DUE
    // here. The user's renewal didn't go through; let them know so they
    // can update payment info before access lapses. We don't email on
    // CANCELLED — `SubscriptionsService.cancel` already sends that mail
    // inline and webhooks for subscription.disable would otherwise
    // double-send.
    if (status === SubscriptionStatus.PAST_DUE) {
      await this.dispatchPaymentFailedEmail(sub, event);
    }
  }

  private async dispatchPaymentFailedEmail(
    sub: { userId: string; planId: string | null },
    event: NormalizedWebhookEvent,
  ): Promise<void> {
    if (!sub.planId) return;
    const [user, plan] = await Promise.all([
      this.usersRepo.findOne({ where: { id: sub.userId } }),
      this.plans.getById(sub.planId).catch(() => null),
    ]);
    if (!user?.email || !plan) return;
    await this.mail.send(MailEvent.SUBSCRIPTION_PAYMENT_FAILED, user.email, {
      recipientName: user.fullName ?? undefined,
      planName: plan.name,
      level: plan.level.toUpperCase(),
      attemptedAt: event.claimedAt ?? new Date(),
      // Paystack retries on a fixed schedule (usually +1, +3, +5 days).
      // We don't have the schedule in the webhook payload, so leave NULL —
      // the template renders generic copy when the retry date is unknown.
      nextAttemptAt: null,
    });
  }

  private async onSubscriptionNotRenew(
    event: NormalizedWebhookEvent,
  ): Promise<void> {
    if (!event.subscriptionId) return;
    const sub = await this.subs.findLatestBySubscriptionId(
      event.subscriptionId,
    );
    if (!sub) return;
    // Keep current status — the sub remains active until expires_at. Notif
    // dispatch belongs to NotificationsService; here we only log so
    // downstream listeners can pick it up. We DO invalidate cache so the
    // mobile sees the cancel-intent flag on next /auth/me read.
    this.logger.log(
      `[webhook] subscription.not_renew user=${sub.userId} sub=${sub.id}`,
    );
    await this.subs.invalidateCache(sub.userId);
  }

  /**
   * Refund handler — revokes the entitlement on the refunded transaction.
   *
   * Flow:
   *   1. Find the subscription by `provider_reference`. The transaction
   *      reference is the only stable link between the refund event and
   *      the original charge — Paystack does NOT echo the subscription id
   *      on refund events for one-time charges, so we can't use that.
   *   2. Flip status to REFUNDED via `applyRefund` (idempotent — re-deliveries
   *      after the first success are no-ops). The status flip alone
   *      strips access because `REFUNDED` is outside the active-status set.
   *   3. Write the financial-event audit row.
   *   4. Invalidate the entitlement cache so the next request returns Free.
   *
   * If no row matches the reference (refund for a transaction we never
   * recorded — replay attack, mis-routed webhook, or pre-launch dust),
   * we still record the financial event for forensics but don't 500.
   */
  private async onRefundProcessed(
    event: NormalizedWebhookEvent,
  ): Promise<void> {
    this.logger.log(
      `[webhook] refund.processed ref=${event.reference ?? 'n/a'}`,
    );
    let userId = event.userId ?? null;
    let subscriptionId: string | null = null;
    let revoked = false;
    if (event.reference) {
      const sub = await this.subs.applyRefund(event.reference);
      if (sub) {
        userId = sub.userId;
        subscriptionId = sub.id;
        revoked = true;
      } else {
        this.logger.warn(
          `[webhook] refund.processed ref=${event.reference} matched no subscription row — recording audit only`,
        );
      }
    }
    // Fall through to cache invalidation even when the refund didn't
    // match a row — the caller may have additional state (e.g. legacy
    // cached entitlement) we'd want flushed anyway.
    if (!revoked && userId) {
      await this.subs.invalidateCache(userId);
    }
    await this.financialAudit.record({
      eventType: FinancialEventType.REFUND,
      userId: userId ?? null,
      subscriptionId,
      amountMinor: event.amountMinor ?? null,
      currency: event.currency ?? null,
      source: 'webhook',
      metadata: {
        provider: 'paystack',
        providerEventId: event.eventId,
        providerReference: event.reference,
        revoked,
      },
    });

    // Refund-confirmation email. Only when the refund actually matched a
    // row — sending "we refunded you" for a reference we never saw would
    // be confusing (and a possible phishing surface).
    if (revoked && userId && event.reference) {
      await this.dispatchRefundEmail(userId, event);
    }
  }

  private async dispatchRefundEmail(
    userId: string,
    event: NormalizedWebhookEvent,
  ): Promise<void> {
    if (!event.reference) return;
    const sub = await this.subs.findLatestByRef(event.reference);
    if (!sub?.planId) return;
    const [user, plan] = await Promise.all([
      this.usersRepo.findOne({ where: { id: userId } }),
      this.plans.getById(sub.planId).catch(() => null),
    ]);
    if (!user?.email || !plan) return;
    const amount =
      event.amountMinor !== undefined
        ? event.amountMinor / 100
        : sub.amountGhs
          ? parseFloat(sub.amountGhs)
          : 0;
    await this.mail.send(MailEvent.REFUND_CONFIRMATION, user.email, {
      recipientName: user.fullName ?? undefined,
      planName: plan.name,
      level: plan.level.toUpperCase(),
      amountDisplay: amount,
      currency: event.currency ?? plan.currency,
      refundedAt: event.claimedAt ?? new Date(),
      reference: event.reference,
    });
  }

  private async onInvoiceUpdate(event: NormalizedWebhookEvent): Promise<void> {
    if (!event.subscriptionId) return;
    const sub = await this.subs.findLatestBySubscriptionId(
      event.subscriptionId,
    );
    if (!sub) return;
    const previousExpiry = sub.expiresAt;
    if (event.nextPaymentDate) sub.expiresAt = event.nextPaymentDate;
    // Some providers send invoice.update with a success flag — leave status
    // parsing to future provider adapters that need it. For now we only
    // refresh the expiry.
    await this.subs.saveSubscription(sub);
    await this.subs.invalidateCache(sub.userId);

    // Renewal email: Paystack sends `invoice.update` with a forward-shifted
    // nextPaymentDate when a recurring charge succeeds. Compare against
    // the prior expiry — if it moved further into the future, this is a
    // successful renewal cycle and we email the user.
    if (
      event.nextPaymentDate &&
      previousExpiry &&
      event.nextPaymentDate.getTime() > previousExpiry.getTime()
    ) {
      await this.dispatchRenewedEmail(sub, event);
    }
  }

  private async dispatchRenewedEmail(
    sub: { userId: string; planId: string | null },
    event: NormalizedWebhookEvent,
  ): Promise<void> {
    if (!sub.planId || !event.nextPaymentDate) return;
    const [user, plan] = await Promise.all([
      this.usersRepo.findOne({ where: { id: sub.userId } }),
      this.plans.getById(sub.planId).catch(() => null),
    ]);
    if (!user?.email || !plan) return;
    const amount =
      event.amountMinor !== undefined ? event.amountMinor / 100 : 0;
    await this.mail.send(MailEvent.SUBSCRIPTION_RENEWED, user.email, {
      recipientName: user.fullName ?? undefined,
      planName: plan.name,
      level: plan.level.toUpperCase(),
      amountDisplay: amount,
      currency: event.currency ?? plan.currency,
      nextRenewalAt: event.nextPaymentDate,
      reference: event.reference ?? '',
    });
  }

  private async resolveUserId(
    event: NormalizedWebhookEvent,
  ): Promise<string | undefined> {
    if (event.userId) return event.userId;
    if (event.reference) {
      const sub = await this.subs.findLatestByRef(event.reference);
      if (sub) return sub.userId;
    }
    if (event.customerId) {
      const sub = await this.subs.findLatestByCustomer(event.customerId);
      if (sub) return sub.userId;
    }
    return undefined;
  }

  private async resolvePlan(event: NormalizedWebhookEvent) {
    if (event.providerPlanCode) {
      const plan = await this.plans.findByProviderPlanCode(
        event.providerPlanCode,
      );
      if (plan) return plan;
    }
    // Fallback: pull the plan off the matching subscription row.
    if (event.reference) {
      const sub = await this.subs.findLatestByRef(event.reference);
      if (sub?.planId) return this.plans.getById(sub.planId);
    }
    if (event.customerId) {
      const sub = await this.subs.findLatestByCustomer(event.customerId);
      if (sub?.planId) return this.plans.getById(sub.planId);
    }
    return null;
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: string }).code === '23505'
    );
  }
}

/**
 * Display label for an AccountType — "Plus" / "Pro" / "Free". Used in
 * receipt + refund emails where users want to see the friendly name,
 * not the snake-case enum.
 */
function accountLabel(account: AccountType): string {
  switch (account) {
    case AccountType.PRO:
      return 'Pro';
    case AccountType.PLUS:
      return 'Plus';
    case AccountType.FREE:
    default:
      return 'Free';
  }
}
