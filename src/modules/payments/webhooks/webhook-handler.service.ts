import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AccountType,
  BillingLogProcessStatus,
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
import { BillingLogService } from '../billing-log.service';
import { PaymentAttemptsService } from '../payment-attempts.service';
import { PaymentProviderRegistry } from '../providers/payment-provider.registry';

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
    private readonly billingLog: BillingLogService,
    private readonly paymentAttempts: PaymentAttemptsService,
    private readonly providers: PaymentProviderRegistry,
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
    // Always write the billing_log row FIRST — even when we plan to
    // drop the event afterwards. This keeps the forensic record
    // complete: every webhook Paystack ever sent us is queryable from
    // /admin/billing-log regardless of how we ultimately handle it.
    // Idempotent on (provider, provider_event_id) so retries are
    // no-ops at the unique-index level; the duplicate row is fetched
    // and returned with `wasDuplicate=true`.
    const { row: billingLogRow, wasDuplicate: billingLogDuplicate } =
      await this.billingLog.record({
        provider,
        eventType: event.type,
        providerEventId: event.eventId,
        reference: event.reference ?? null,
        userId: event.userId ?? null,
        rawPayload: event.raw,
        occurredAt: event.claimedAt ?? null,
      });

    if (event.claimedAt) {
      const drift = Math.abs(Date.now() - event.claimedAt.getTime());
      if (drift > WEBHOOK_FRESHNESS_WINDOW_MS) {
        this.logger.warn(
          `[webhook] stale event ${provider}:${event.eventId} claimedAt=${event.claimedAt.toISOString()} drift=${Math.round(drift / 1000)}s — rejecting`,
        );
        // Stale events get the security-alarm status so the admin
        // /admin/billing-log filter picks them up — a stale signed
        // body is either a replay attempt or a long-queued legitimate
        // delivery; operator needs to triage.
        await this.billingLog.markProcessed(
          billingLogRow.id,
          BillingLogProcessStatus.NO_MATCHING_PAYMENT,
          {
            error: `stale_rejected: claimedAt drift=${Math.round((Date.now() - event.claimedAt.getTime()) / 1000)}s`,
          },
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
        // Mark the billing_log row as a duplicate so the admin can
        // see at-a-glance that the event landed but did not retrigger
        // processing. This is the forensic-anchor for pre-refactor
        // events that may never have had a billing_log entry — the
        // row written above (`record`) IS that entry.
        if (!billingLogDuplicate) {
          await this.billingLog.markProcessed(
            billingLogRow.id,
            BillingLogProcessStatus.DUPLICATE,
            {
              error: 'replay of already-processed payment_events row',
            },
          );
        }
        return { duplicate: true, processed: false };
      }
      // Row exists but processing previously failed (or is in-flight from
      // a near-simultaneous delivery). Fall through and try again.
      this.logger.log(
        `[webhook] retrying unprocessed event ${provider}:${event.eventId}`,
      );
    }

    try {
      await this.dispatch(event, billingLogRow.id);
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
      await this.billingLog
        .markProcessed(billingLogRow.id, BillingLogProcessStatus.ERROR, {
          error: message,
        })
        .catch((logErr) =>
          this.logger.error(
            `[webhook] failed to mark billing_log as error: ${(logErr as Error).message}`,
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

  private async dispatch(
    event: NormalizedWebhookEvent,
    billingLogId: string,
  ): Promise<void> {
    switch (event.type) {
      case 'charge.success':
        return this.onChargeSuccess(event, billingLogId);
      case 'subscription.create':
        return this.onSubscriptionCreate(event, billingLogId);
      case 'subscription.disable':
        return this.onStatusChange(
          event,
          SubscriptionStatus.CANCELLED,
          billingLogId,
        );
      case 'subscription.not_renew':
        return this.onSubscriptionNotRenew(event, billingLogId);
      case 'invoice.failed':
        return this.onInvoiceFailed(event, billingLogId);
      case 'invoice.update':
        return this.onInvoiceUpdate(event, billingLogId);
      case 'refund.processed':
        return this.onRefundProcessed(event, billingLogId);
      case 'unknown':
      default:
        this.logger.warn(`[webhook] unhandled event: ${event.type}`);
        await this.billingLog.markProcessed(
          billingLogId,
          BillingLogProcessStatus.SUCCESS,
        );
    }
  }

  private async onChargeSuccess(
    event: NormalizedWebhookEvent,
    billingLogId: string,
  ): Promise<void> {
    // GATE: every charge.success must reference a payment_attempt we
    // initiated. Missing rows are the security alarm — either Paystack
    // misrouted a webhook for another integration, or the body was
    // crafted by an attacker who knows our endpoint but doesn't have our
    // payment_attempts table. We log + flag the billing_log row + return
    // without granting any entitlement.
    if (!event.reference) {
      this.logger.error(
        '[webhook] charge.success with no reference — refusing to process',
      );
      await this.billingLog.markProcessed(
        billingLogId,
        BillingLogProcessStatus.NO_MATCHING_PAYMENT,
        { error: 'missing reference' },
      );
      return;
    }
    let attempt = await this.paymentAttempts.findByReference(event.reference);
    let isRenewal = false;

    // Detect Pro auto-renewal: Paystack auto-debits the saved card and
    // delivers a fresh `charge.success` with a NEW reference (one we
    // never initiated) but the SAME provider_subscription_id we already
    // hold. Treat as a legitimate renewal — synthesise a paid
    // payment_attempt so the user's history shows the cycle, and let the
    // activation path extend expires_at.
    //
    // GUARDS (all required to take the renewal path):
    //   1. Existing sub status is ACTIVE — never resurrect a cancelled,
    //      refunded, or expired sub. A renewal arriving against a
    //      cancelled-Paystack-subscription (we asked Paystack to stop,
    //      but the debit cleared anyway) is alarm-worthy.
    //   2. Existing sub's plan is RECURRING. If Paystack ever sends a
    //      subscription_code on a one-time Plus charge (replay, provider
    //      bug, mis-routed event), treating it as a renewal would feed
    //      `consumePaidAttempt` a billingInterval on a Plus plan and
    //      blow up with "Recurring payments require a billing interval"
    //      — webhook retries forever.
    if (!attempt && event.subscriptionId) {
      const existingSub = await this.subs.findLatestBySubscriptionId(
        event.subscriptionId,
      );
      if (
        existingSub &&
        existingSub.planId &&
        existingSub.billingInterval &&
        existingSub.status === SubscriptionStatus.ACTIVE
      ) {
        // Plan resolution with belt-and-suspenders fallback. We
        // prefer the catalogue row's `paymentKind` as the source of
        // truth — that's the field reviewers rely on to distinguish
        // Plus vs Pro. If the plan has been hard-deleted (which
        // shouldn't happen but we don't want a missing-row to
        // silently break renewals for thousands of users), fall back
        // to the subscription's own `billingInterval`: presence of a
        // cadence is a hard signal that the original purchase was
        // recurring (Plus rows always have NULL billingInterval).
        const renewalPlan = await this.plans
          .getById(existingSub.planId)
          .catch(() => null);
        const planIsRecurring = renewalPlan
          ? renewalPlan.paymentKind === PaymentKind.RECURRING
          : existingSub.billingInterval != null;
        if (planIsRecurring) {
          const renewalAmountMinor = event.amountMinor ?? 0;
          // Plant a PENDING attempt. The PAID promotion happens
          // inside applyWebhookActivation's advisory lock, AFTER
          // re-validating that the target subscription is still
          // ACTIVE. This closes the cancel-vs-renewal race that
          // previously left orphan PAID rows on retried webhooks.
          attempt = await this.subs.recordPendingRenewalAttempt({
            userId: existingSub.userId,
            planId: existingSub.planId,
            billingInterval: existingSub.billingInterval,
            amountMinor: renewalAmountMinor,
            amountGhs: renewalAmountMinor / 100,
            currency: event.currency ?? 'GHS',
            provider: 'paystack',
            providerReference: event.reference,
            providerSubscriptionId: event.subscriptionId,
            providerCustomerId: event.customerId ?? null,
            providerEventId: event.eventId,
            subscriptionId: existingSub.id,
          });
          isRenewal = true;
          this.logger.log(
            `[webhook] charge.success ref=${event.reference} matched renewal of sub=${existingSub.id}` +
              (renewalPlan
                ? ''
                : ' (plan hard-deleted; fell back to billingInterval signal)'),
          );
        } else {
          this.logger.error(
            `[webhook] charge.success ref=${event.reference} carried subscription_code ${event.subscriptionId} but matching sub=${existingSub.id} is not recurring (plan.paymentKind=${renewalPlan?.paymentKind ?? 'unknown'}, billingInterval=${existingSub.billingInterval ?? 'null'}) — refusing to treat as renewal`,
          );
        }
      } else if (existingSub) {
        this.logger.error(
          `[webhook] charge.success ref=${event.reference} matched sub=${existingSub.id} but status=${existingSub.status} — refusing to resurrect via renewal; auto-refund pending`,
        );
        // Auto-refund: Paystack debited a card for a subscription
        // we've already cancelled/refunded. Don't grant entitlement,
        // don't synthesise a renewal attempt, AND don't keep the
        // user's money. The refund call is best-effort — failures
        // are surfaced via the NO_MATCHING_PAYMENT billing_log entry
        // a few lines down, so ops can issue a manual refund from
        // the Paystack dashboard.
        try {
          const paystack = this.providers.get('paystack');
          const amountMinor = event.amountMinor;
          await paystack.refundTransaction({
            reference: event.reference,
            amountMinor: amountMinor !== undefined ? amountMinor : undefined,
            currency: event.currency,
            reason: `cancelled_sub_debit: sub=${existingSub.id} status=${existingSub.status}`,
          });
        } catch (err) {
          this.logger.error(
            `[webhook] auto-refund for cancelled-sub debit ref=${event.reference} threw: ${(err as Error).message}`,
          );
        }
      }
    }

    if (!attempt) {
      this.logger.error(
        `[webhook] charge.success ref=${event.reference} has no matching payment_attempt — ALARM, refusing to grant entitlement`,
      );
      await this.billingLog.markProcessed(
        billingLogId,
        BillingLogProcessStatus.NO_MATCHING_PAYMENT,
        { error: 'no matching payment_attempt for reference' },
      );
      return;
    }

    const userId = attempt.userId;
    const plan = await this.resolvePlan(event);
    if (!plan) {
      this.logger.warn(
        `[webhook] charge.success with no matching plan (code=${event.providerPlanCode})`,
      );
      await this.billingLog.markProcessed(
        billingLogId,
        BillingLogProcessStatus.ERROR,
        {
          paymentAttemptId: attempt.id,
          userId,
          error: 'no plan resolvable',
        },
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
        : (attempt.billingInterval ?? null);
    if (!isOneTime && !interval) {
      this.logger.warn(
        `[webhook] charge.success could not infer billing interval for recurring plan=${plan.id}`,
      );
      await this.billingLog.markProcessed(
        billingLogId,
        BillingLogProcessStatus.ERROR,
        {
          paymentAttemptId: attempt.id,
          userId,
          error: 'could not infer billing interval',
        },
      );
      return;
    }

    const amountDisplay =
      event.amountMinor !== undefined ? event.amountMinor / 100 : undefined;

    const { alarmDuplicatePlus } = await this.subs.applyWebhookActivation({
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
      // Single source of truth for renewal expiry: prefer the
      // provider-reported next-payment date over locally-computed
      // `now + cadence` so onChargeSuccess and onInvoiceUpdate can't
      // drift relative to each other on the same renewal cycle.
      expiresAt: event.nextPaymentDate ?? undefined,
      isRenewal,
    });

    // SKIP downstream side-effects on the duplicate-Plus alarm path —
    // the user is owed a refund, not a receipt or an ACTIVATION event.
    // Mark the billing_log row with the alarm reason so the admin
    // /admin/billing-log filter surfaces it alongside the
    // payment_attempts entry.
    if (alarmDuplicatePlus) {
      const linkedAlarm = await this.paymentAttempts.findById(attempt.id);
      await this.billingLog.markProcessed(
        billingLogId,
        BillingLogProcessStatus.NO_MATCHING_PAYMENT,
        {
          paymentAttemptId: attempt.id,
          subscriptionId: linkedAlarm?.subscriptionId ?? null,
          userId,
          error: 'duplicate_plus_charge: user already owns Plus on this level',
        },
      );
      return;
    }

    await this.financialAudit.record({
      eventType: FinancialEventType.ACTIVATION,
      userId,
      amountMinor: event.amountMinor ?? null,
      currency: event.currency ?? null,
      source: 'webhook',
      // Dedup key: a retried delivery of the same charge.success
      // event id is absorbed by the partial unique index instead of
      // writing a second ACTIVATION row.
      providerEventId: event.eventId,
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
        isRenewal,
      },
    });

    // Reload to pick up the back-filled subscription_id so the
    // billing_log row carries a complete back-reference.
    const linked = await this.paymentAttempts.findById(attempt.id);
    await this.billingLog.markProcessed(
      billingLogId,
      BillingLogProcessStatus.SUCCESS,
      {
        paymentAttemptId: attempt.id,
        subscriptionId: linked?.subscriptionId ?? null,
        userId,
      },
    );

    // Email dispatch. Best-effort — MailService never throws on
    // failure so a Resend hiccup can't roll back an activation.
    //
    // Renewal cycles get the dedicated "renewed" template (different
    // copy — emphasizes the recurring nature, links to manage page,
    // shows the new period end). First activations / one-time
    // charges get the original "payment success" receipt with the
    // PDF.
    //
    // Sending from HERE (instead of onInvoiceUpdate) ensures the
    // email fires reliably on every renewal cycle. The previous
    // design sent from onInvoiceUpdate using a `nextPaymentDate >
    // expiresAt` comparison, which broke once onChargeSuccess
    // became the single writer of expiresAt — the comparison
    // collapsed to false on the typical event ordering.
    if (isRenewal) {
      await this.dispatchPaymentReceiptEmail(
        userId,
        plan,
        event,
        amountDisplay,
        true,
      );
    } else {
      await this.dispatchPaymentReceiptEmail(
        userId,
        plan,
        event,
        amountDisplay,
        false,
      );
    }
  }

  private async dispatchPaymentReceiptEmail(
    userId: string,
    plan: SubscriptionPlanEntity,
    event: NormalizedWebhookEvent,
    amountDisplay: number | undefined,
    isRenewal: boolean,
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
    const idempotencyKey = event.reference
      ? `payment_success:${event.reference}`
      : undefined;
    await this.mail.send(
      MailEvent.PAYMENT_SUCCESS,
      user.email,
      {
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
      },
      {
        userId,
        idempotencyKey,
        dedupKey: idempotencyKey,
      },
    );
    if (isRenewal) {
      this.logger.log(
        `[mail] renewal receipt dispatched ref=${event.reference} user=${userId}`,
      );
    }
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
    billingLogId: string,
  ): Promise<void> {
    if (!event.subscriptionId || !event.customerId) {
      await this.billingLog.markProcessed(
        billingLogId,
        BillingLogProcessStatus.SUCCESS,
      );
      return;
    }
    const sub = await this.subs.findLatestByCustomer(event.customerId);
    if (!sub) {
      this.logger.warn(
        `[webhook] subscription.create with no matching subscription row (customer=${event.customerId})`,
      );
      await this.billingLog.markProcessed(
        billingLogId,
        BillingLogProcessStatus.SUCCESS,
      );
      return;
    }
    sub.providerSubscriptionId = event.subscriptionId;
    await this.subs.saveSubscription(sub);
    await this.subs.invalidateCache(sub.userId);
    await this.billingLog.markProcessed(
      billingLogId,
      BillingLogProcessStatus.SUCCESS,
      { subscriptionId: sub.id, userId: sub.userId },
    );
  }

  private async onStatusChange(
    event: NormalizedWebhookEvent,
    status: SubscriptionStatus,
    billingLogId: string,
  ): Promise<void> {
    if (!event.subscriptionId) {
      await this.billingLog.markProcessed(
        billingLogId,
        BillingLogProcessStatus.SUCCESS,
      );
      return;
    }
    const sub = await this.subs.findLatestBySubscriptionId(
      event.subscriptionId,
    );
    if (!sub) {
      await this.billingLog.markProcessed(
        billingLogId,
        BillingLogProcessStatus.SUCCESS,
      );
      return;
    }
    sub.status = status;
    await this.subs.saveSubscription(sub);
    await this.subs.invalidateCache(sub.userId);
    await this.billingLog.markProcessed(
      billingLogId,
      BillingLogProcessStatus.SUCCESS,
      { subscriptionId: sub.id, userId: sub.userId },
    );
    await this.financialAudit.record({
      eventType:
        status === SubscriptionStatus.CANCELLED
          ? FinancialEventType.CANCELLATION
          : FinancialEventType.STATUS_CORRECTION,
      userId: sub.userId,
      subscriptionId: sub.id,
      source: 'webhook',
      providerEventId: event.eventId,
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

  /**
   * `invoice.failed` — Paystack tried to auto-debit and the bank
   * declined. Paystack will retry on its own schedule (typically +1,
   * +3, +5 days, ~72h total). We intentionally do NOT change the
   * subscription status here:
   *
   *   - The user has already paid for the current period; expires_at
   *     hasn't moved. Stripping access immediately would punish a user
   *     mid-cycle for a renewal attempt that may still succeed on
   *     retry. Their access lapses naturally at expires_at if all
   *     retries fail.
   *   - Paystack ultimately sends `subscription.disable` /
   *     `subscription.not_renew` when it gives up — those handlers
   *     own the terminal-state transition.
   *
   * We DO send the dunning email so the user can update their card
   * before retries are exhausted.
   */
  private async onInvoiceFailed(
    event: NormalizedWebhookEvent,
    billingLogId: string,
  ): Promise<void> {
    if (!event.subscriptionId) {
      await this.billingLog.markProcessed(
        billingLogId,
        BillingLogProcessStatus.SUCCESS,
      );
      return;
    }
    const sub = await this.subs.findLatestBySubscriptionId(
      event.subscriptionId,
    );
    if (!sub) {
      await this.billingLog.markProcessed(
        billingLogId,
        BillingLogProcessStatus.SUCCESS,
      );
      return;
    }

    await this.financialAudit.record({
      eventType: FinancialEventType.STATUS_CORRECTION,
      userId: sub.userId,
      subscriptionId: sub.id,
      source: 'webhook',
      providerEventId: event.eventId,
      metadata: {
        provider: 'paystack',
        providerEventId: event.eventId,
        kind: 'invoice_failed_no_status_change',
        keepAccessUntil: sub.expiresAt?.toISOString() ?? null,
      },
    });
    await this.billingLog.markProcessed(
      billingLogId,
      BillingLogProcessStatus.SUCCESS,
      { subscriptionId: sub.id, userId: sub.userId },
    );
    await this.dispatchPaymentFailedEmail(sub, event);
  }

  private async dispatchPaymentFailedEmail(
    sub: {
      userId: string;
      planId: string | null;
      expiresAt?: Date | null;
    },
    event: NormalizedWebhookEvent,
  ): Promise<void> {
    if (!sub.planId) return;
    const [user, plan] = await Promise.all([
      this.usersRepo.findOne({ where: { id: sub.userId } }),
      this.plans.getById(sub.planId).catch(() => null),
    ]);
    if (!user?.email || !plan) return;
    const dedupKey = event.eventId
      ? `payment_failed:${event.eventId}`
      : `payment_failed:${sub.userId}:${event.claimedAt?.toISOString() ?? 'now'}`;
    await this.mail.send(
      MailEvent.SUBSCRIPTION_PAYMENT_FAILED,
      user.email,
      {
        recipientName: user.fullName ?? undefined,
        planName: plan.name,
        level: plan.level.toUpperCase(),
        attemptedAt: event.claimedAt ?? new Date(),
        nextAttemptAt: null,
        accessUntil: sub.expiresAt ?? null,
      },
      { userId: sub.userId, dedupKey },
    );
  }

  private async onSubscriptionNotRenew(
    event: NormalizedWebhookEvent,
    billingLogId: string,
  ): Promise<void> {
    if (!event.subscriptionId) {
      await this.billingLog.markProcessed(
        billingLogId,
        BillingLogProcessStatus.SUCCESS,
      );
      return;
    }
    const sub = await this.subs.findLatestBySubscriptionId(
      event.subscriptionId,
    );
    if (!sub) {
      await this.billingLog.markProcessed(
        billingLogId,
        BillingLogProcessStatus.SUCCESS,
      );
      return;
    }
    // Keep current status — the sub remains active until expires_at. Notif
    // dispatch belongs to NotificationsService; here we only log so
    // downstream listeners can pick it up. We DO invalidate cache so the
    // mobile sees the cancel-intent flag on next /auth/me read.
    this.logger.log(
      `[webhook] subscription.not_renew user=${sub.userId} sub=${sub.id}`,
    );
    await this.subs.invalidateCache(sub.userId);
    await this.billingLog.markProcessed(
      billingLogId,
      BillingLogProcessStatus.SUCCESS,
      { subscriptionId: sub.id, userId: sub.userId },
    );
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
    billingLogId: string,
  ): Promise<void> {
    this.logger.log(
      `[webhook] refund.processed ref=${event.reference ?? 'n/a'}`,
    );
    let userId = event.userId ?? null;
    let subscriptionId: string | null = null;
    let paymentAttemptId: string | null = null;
    let revoked = false;
    if (event.reference) {
      // Look up the attempt for the billing_log backref before
      // applyRefund mutates state — gives us the id even when the
      // subscription was never created (duplicate-Plus alarm path).
      const attempt = await this.paymentAttempts.findByReference(
        event.reference,
      );
      if (attempt) {
        paymentAttemptId = attempt.id;
        userId = userId ?? attempt.userId;
      }
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
      providerEventId: event.eventId,
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

    await this.billingLog.markProcessed(
      billingLogId,
      BillingLogProcessStatus.SUCCESS,
      {
        paymentAttemptId,
        subscriptionId,
        userId,
      },
    );
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
    await this.mail.send(
      MailEvent.REFUND_CONFIRMATION,
      user.email,
      {
        recipientName: user.fullName ?? undefined,
        planName: plan.name,
        level: plan.level.toUpperCase(),
        amountDisplay: amount,
        currency: event.currency ?? plan.currency,
        refundedAt: event.claimedAt ?? new Date(),
        reference: event.reference,
      },
      {
        userId,
        idempotencyKey: event.eventId
          ? `refund_confirmation:${event.eventId}`
          : `refund_confirmation:${event.reference}`,
        dedupKey: event.eventId
          ? `refund_confirmation:${event.eventId}`
          : `refund_confirmation:${event.reference}`,
      },
    );
  }

  /**
   * `invoice.update` — Paystack reports a renewal cycle. Under the
   * single-source-of-truth model, `onChargeSuccess` is responsible
   * for advancing `expires_at` (consuming this event's
   * `nextPaymentDate` via `applyWebhookActivation`). This handler
   * exists to send the renewal email when the cycle moved forward
   * and to log to billing_log; it intentionally does NOT mutate
   * `subscriptions.expires_at` to avoid racing the charge.success
   * write.
   */
  private async onInvoiceUpdate(
    event: NormalizedWebhookEvent,
    billingLogId: string,
  ): Promise<void> {
    if (!event.subscriptionId) {
      await this.billingLog.markProcessed(
        billingLogId,
        BillingLogProcessStatus.SUCCESS,
      );
      return;
    }
    const sub = await this.subs.findLatestBySubscriptionId(
      event.subscriptionId,
    );
    if (!sub) {
      await this.billingLog.markProcessed(
        billingLogId,
        BillingLogProcessStatus.SUCCESS,
      );
      return;
    }

    // Renewal email is dispatched from `onChargeSuccess` (when
    // `isRenewal=true`), not here. Sending from there ensures the
    // notification fires reliably once per cycle and lives next to
    // the state change. This handler is now a thin forensic
    // marker — we record the event in billing_log and return.
    await this.billingLog.markProcessed(
      billingLogId,
      BillingLogProcessStatus.SUCCESS,
      { subscriptionId: sub.id, userId: sub.userId },
    );
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
