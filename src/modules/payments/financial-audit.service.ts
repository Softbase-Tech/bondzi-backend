import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  FinancialEvent,
  FinancialEventSource,
  FinancialEventType,
} from './entities/financial-event.entity';
import { redactPii } from '../../common/utils/redact-pii.util';

export interface RecordFinancialEventInput {
  eventType: FinancialEventType;
  userId?: string | null;
  subscriptionId?: string | null;
  amountMinor?: number | null;
  currency?: string | null;
  source: FinancialEventSource;
  actorId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Single entry point for writing to financial_events. Every money-touching
 * code path should call `record()` rather than `logger.log(...)` so a
 * year from now we can answer "what happened to this user's billing?"
 * with one SQL query.
 *
 * Failure handling: a write failure is logged but NEVER rethrown. The
 * primary side effect (activation, refund, etc.) must not roll back
 * because the audit trail couldn't write. A reconciliation job can
 * fill gaps from payment_events + subscriptions snapshots if needed.
 */
@Injectable()
export class FinancialAuditService {
  private readonly logger = new Logger(FinancialAuditService.name);

  constructor(
    @InjectRepository(FinancialEvent)
    private readonly repo: Repository<FinancialEvent>,
  ) {}

  async record(input: RecordFinancialEventInput): Promise<void> {
    try {
      await this.repo.save(
        this.repo.create({
          eventType: input.eventType,
          userId: input.userId ?? null,
          subscriptionId: input.subscriptionId ?? null,
          amountMinor: input.amountMinor ?? null,
          currency: input.currency ?? null,
          source: input.source,
          actorId: input.actorId ?? null,
          // Defence-in-depth: scrub PII before persisting even though
          // callers should pass only ids + amounts. A future caller
          // that hands the raw provider payload in won't leak email
          // / phone into the long-lived ledger.
          metadata: input.metadata
            ? (redactPii(input.metadata) as Record<string, unknown>)
            : null,
        }),
      );
    } catch (err) {
      this.logger.error(
        `[financial-audit] write failed event=${input.eventType} user=${input.userId ?? 'n/a'}: ${(err as Error).message}`,
      );
    }
  }
}
