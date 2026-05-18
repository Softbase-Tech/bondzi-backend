import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PaymentEvent } from './entities/payment-event.entity';
import { FinancialEvent } from './entities/financial-event.entity';
import { redactPaymentPayload } from './utils/redact-payload.util';

/**
 * Historical/audit queries over payment_events. Webhook ingestion has moved
 * to WebhookHandlerService (per-provider normalized events).
 */
@Injectable()
export class PaymentsService {
  constructor(
    @InjectRepository(PaymentEvent)
    private readonly eventsRepo: Repository<PaymentEvent>,
    @InjectRepository(FinancialEvent)
    private readonly financialRepo: Repository<FinancialEvent>,
  ) {}

  /**
   * Admin-facing listing. Rows are returned with the rawPayload PII
   * fields ([REDACTED]) so the dashboard doesn't expose customer
   * email / phone / card last4 to the operator. The DB row itself
   * is untouched — forensics queries still see the original payload.
   */
  async listEvents(limit = 100): Promise<PaymentEvent[]> {
    const rows = await this.eventsRepo.find({
      order: { createdAt: 'DESC' },
      take: limit,
    });
    return rows.map((r) => ({
      ...r,
      rawPayload: redactPaymentPayload(r.rawPayload) as typeof r.rawPayload,
    }));
  }

  /**
   * Admin-facing financial-event ledger query. Filters are all
   * optional; the result is ordered by created_at DESC. The endpoint
   * caps limit at 500 — this is forensic data, not the user inbox,
   * so paginated drill-down via `since` is fine.
   */
  async listFinancialEvents(opts: {
    limit: number;
    userId?: string;
    eventType?: string;
    source?: string;
    since?: Date;
  }): Promise<FinancialEvent[]> {
    const qb = this.financialRepo
      .createQueryBuilder('fe')
      .orderBy('fe.created_at', 'DESC')
      .limit(opts.limit);
    if (opts.userId) qb.andWhere('fe.user_id = :uid', { uid: opts.userId });
    if (opts.eventType)
      qb.andWhere('fe.event_type = :et', { et: opts.eventType });
    if (opts.source) qb.andWhere('fe.source = :src', { src: opts.source });
    if (opts.since)
      qb.andWhere('fe.created_at >= :since', { since: opts.since });
    return qb.getMany();
  }

  async listUserPayments(userId: string): Promise<PaymentEvent[]> {
    // Previously did `raw_payload -> 'data' -> 'metadata' ->> 'userId'`
    // — a JSONB expression scan that visited every webhook row ever
    // received. The denormalised `user_id` column already exists on
    // `payment_events` (and is indexed by the 1800… migration), so we
    // query it directly. Historical rows where the webhook handler
    // couldn't resolve a user at insert time still fall back to the
    // JSONB path so they stay reachable.
    return this.eventsRepo
      .createQueryBuilder('e')
      .where('e.user_id = :userId', { userId })
      .orWhere(
        `(e.user_id is null and e.raw_payload -> 'data' -> 'metadata' ->> 'userId' = :userId)`,
        { userId },
      )
      .orderBy('e.created_at', 'DESC')
      .limit(200)
      .getMany();
  }
}
