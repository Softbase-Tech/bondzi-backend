import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SubscriptionStatus } from '../../../common/types/enums';
import { PlansService } from '../../subscriptions/plans/plans.service';
import { SubscriptionsService } from '../../subscriptions/subscriptions.service';
import { PaymentEvent } from '../entities/payment-event.entity';
import { NormalizedWebhookEvent } from '../providers/payment-provider.interface';

/**
 * Provider-agnostic webhook processor. Idempotency + event persistence +
 * side effects on the subscription row live here. Signature verification
 * and parsing happen earlier, in the per-provider controller entrypoint.
 *
 * Idempotency (spec §5.8):
 *   1. Insert a payment_events row keyed by (provider, provider_event_id).
 *   2. On duplicate-key violation, return without reprocessing.
 *   3. Process, then flip processed=true with timestamp.
 *   4. On error, persist error text. Controller still returns 200 — retries
 *      would cause double-processing.
 */
@Injectable()
export class WebhookHandlerService {
  private readonly logger = new Logger(WebhookHandlerService.name);

  constructor(
    @InjectRepository(PaymentEvent)
    private readonly eventsRepo: Repository<PaymentEvent>,
    private readonly subs: SubscriptionsService,
    private readonly plans: PlansService,
  ) {}

  async process(
    provider: string,
    event: NormalizedWebhookEvent,
  ): Promise<{ duplicate: boolean; processed: boolean }> {
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
      if (this.isUniqueViolation(err)) {
        this.logger.log(
          `[webhook] duplicate event ${provider}:${event.eventId} — skipping`,
        );
        return { duplicate: true, processed: false };
      }
      throw err;
    }

    try {
      await this.dispatch(event);
      await this.eventsRepo.update(
        { provider, providerEventId: event.eventId },
        { processed: true, processedAt: new Date() },
      );
      return { duplicate: false, processed: true };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(
        `[webhook] processing ${event.type} failed: ${message}`,
      );
      await this.eventsRepo.update(
        { provider, providerEventId: event.eventId },
        { error: message },
      );
      return { duplicate: false, processed: false };
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
        this.logger.log(`[webhook] refund.processed — Phase 2 handler`);
        return;
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
    // dispatch belongs to NotificationsService; here we only log so downstream
    // listeners can pick it up.
    this.logger.log(
      `[webhook] subscription.not_renew user=${sub.userId} sub=${sub.id}`,
    );
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
