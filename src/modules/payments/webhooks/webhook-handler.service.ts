import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SubscriptionStatus } from '../../../common/types/enums';
import { PlansService } from '../../subscriptions/plans/plans.service';
import { SubscriptionsService } from '../../subscriptions/subscriptions.service';
import { PaymentEvent } from '../entities/payment-event.entity';
import { FinancialEventType } from '../entities/financial-event.entity';
import { FinancialAuditService } from '../financial-audit.service';
import { NormalizedWebhookEvent } from '../providers/payment-provider.interface';

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
    private readonly subs: SubscriptionsService,
    private readonly plans: PlansService,
    private readonly financialAudit: FinancialAuditService,
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

    const interval = event.providerPlanCode
      ? this.plans.intervalForProviderPlanCode(plan, event.providerPlanCode)
      : null;
    if (!interval) {
      this.logger.warn(
        `[webhook] charge.success could not infer billing interval (plan=${plan.id})`,
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
      providerSubscriptionId: event.subscriptionId,
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
        interval,
      },
    });
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
   * Phase 1 refund handler: we don't reverse subscription rows yet (that
   * is Phase 2 — admin co-sign + audit row), but we MUST invalidate the
   * subscription-status cache for the affected user. Otherwise a user
   * who just got refunded continues to read "active" from cache for up
   * to 60s of guard-cached TTL after the webhook lands — paid back AND
   * still premium. The DB row doesn't move yet, so the next cache miss
   * will re-cache "active" until the Phase 2 handler ships, but at
   * least the immediate stale window is closed.
   */
  private async onRefundProcessed(
    event: NormalizedWebhookEvent,
  ): Promise<void> {
    this.logger.log(
      `[webhook] refund.processed ref=${event.reference ?? 'n/a'}`,
    );
    const userId = await this.resolveUserId(event);
    if (userId) {
      await this.subs.invalidateCache(userId);
    }
    await this.financialAudit.record({
      eventType: FinancialEventType.REFUND,
      userId: userId ?? null,
      amountMinor: event.amountMinor ?? null,
      currency: event.currency ?? null,
      source: 'webhook',
      metadata: {
        provider: 'paystack',
        providerEventId: event.eventId,
        providerReference: event.reference,
      },
    });
  }

  private async onInvoiceUpdate(event: NormalizedWebhookEvent): Promise<void> {
    if (!event.subscriptionId) return;
    const sub = await this.subs.findLatestBySubscriptionId(
      event.subscriptionId,
    );
    if (!sub) return;
    if (event.nextPaymentDate) sub.expiresAt = event.nextPaymentDate;
    // Some providers send invoice.update with a success flag — leave status
    // parsing to future provider adapters that need it. For now we only
    // refresh the expiry.
    await this.subs.saveSubscription(sub);
    await this.subs.invalidateCache(sub.userId);
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
