import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { PaymentEvent } from '../modules/payments/entities/payment-event.entity';
import { WebhookHandlerService } from '../modules/payments/webhooks/webhook-handler.service';
import { PaymentProviderRegistry } from '../modules/payments/providers/payment-provider.registry';
import { NormalizedWebhookEvent } from '../modules/payments/providers/payment-provider.interface';

/**
 * Reconciliation safety net for the payments webhook pipeline.
 *
 * The handler now throws on processing failure so the provider retries
 * via HTTP 5xx. But provider retry policies are bounded (Paystack: 72h,
 * 5 attempts), so a long DB outage could still strand events with
 * `processed=false` past the provider's retry window. This cron picks
 * those up and re-runs them locally.
 *
 * Grace window: events newer than 10 min are ignored — they're likely
 * still being retried by the provider, and racing the provider would
 * cause double-processing (which is safe due to idempotency, but
 * wasteful).
 *
 * The job is worker-only — see other `@Cron` handlers for the gating
 * idiom. A second pass running in the api container would double the
 * load on Postgres for no reason.
 */
@Injectable()
export class WebhookReconciliationJob {
  private readonly logger = new Logger(WebhookReconciliationJob.name);

  /** Don't touch events newer than this — provider is still retrying. */
  private static readonly GRACE_MS = 10 * 60 * 1000;
  /** Cap per tick so we don't starve the worker if backlog spikes. */
  private static readonly BATCH = 50;

  constructor(
    @InjectRepository(PaymentEvent)
    private readonly eventsRepo: Repository<PaymentEvent>,
    private readonly handler: WebhookHandlerService,
    private readonly providers: PaymentProviderRegistry,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    if (process.env.WORKER_MODE !== 'true') return;

    const cutoff = new Date(Date.now() - WebhookReconciliationJob.GRACE_MS);
    const stuck = await this.eventsRepo.find({
      where: { processed: false, createdAt: LessThan(cutoff) },
      order: { createdAt: 'ASC' },
      take: WebhookReconciliationJob.BATCH,
    });

    if (stuck.length === 0) return;
    this.logger.log(
      `[webhook-reconcile] retrying ${stuck.length} unprocessed event(s)`,
    );

    for (const row of stuck) {
      try {
        // Re-parse the raw payload through the provider adapter so we
        // get the same normalized shape the live path produced. If the
        // provider was removed since the event landed, drop the row
        // (logged) — we can't replay it.
        if (!this.providers.has(row.provider)) {
          this.logger.warn(
            `[webhook-reconcile] provider '${row.provider}' no longer registered; skipping ${row.id}`,
          );
          continue;
        }
        const provider = this.providers.get(row.provider);
        const event: NormalizedWebhookEvent = provider.parseWebhookEvent(
          Buffer.from(JSON.stringify(row.rawPayload), 'utf8'),
        );
        await this.handler.process(row.provider, event);
      } catch (err) {
        // process() will have already persisted the error message and
        // re-thrown; log here only at debug since the row record is
        // the source of truth.
        this.logger.warn(
          `[webhook-reconcile] event ${row.id} still failing: ${(err as Error).message}`,
        );
      }
    }
  }
}
