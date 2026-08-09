import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PaymentEvent } from './entities/payment-event.entity';
import { FinancialEvent } from './entities/financial-event.entity';
import { PaymentAttempt } from './entities/payment-attempt.entity';
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
    @InjectRepository(PaymentAttempt)
    private readonly attemptsRepo: Repository<PaymentAttempt>,
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

  /**
   * User-facing payment history. Returns ALL payment_attempts for the
   * user — pending, paid, failed, refunded, and abandoned — joined to
   * the plan so the UI can render account/level/cadence labels without
   * a second roundtrip.
   *
   * Ordered by initiated_at DESC (the natural "newest first" axis for
   * a user looking at their checkout timeline). Capped at 100 rows;
   * pagination is via `offset` and the optional `before` cursor.
   */
  async listUserPaymentAttempts(
    userId: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<{ items: PaymentAttempt[]; total: number }> {
    const limit = Math.min(100, Math.max(1, opts.limit ?? 25));
    const offset = Math.max(0, opts.offset ?? 0);
    const [items, total] = await this.attemptsRepo.findAndCount({
      where: { userId },
      relations: ['plan'],
      order: { initiatedAt: 'DESC' },
      take: limit,
      skip: offset,
    });
    return { items, total };
  }
}
