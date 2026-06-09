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
  /**
   * Provider event id for webhook-sourced records. When present, the
   * (event_type, provider_event_id) partial unique index dedups a
   * second delivery of the same webhook so two concurrent retries
   * don't write two ACTIVATION / RENEWAL / REFUND rows for one charge.
   * Non-webhook callers leave this undefined.
   */
  providerEventId?: string | null;
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
      const values: Record<string, unknown> = {
        eventType: input.eventType,
        userId: input.userId ?? null,
        subscriptionId: input.subscriptionId ?? null,
        amountMinor: input.amountMinor ?? null,
        currency: input.currency ?? null,
        source: input.source,
        actorId: input.actorId ?? null,
        providerEventId: input.providerEventId ?? null,
        // Defence-in-depth: scrub PII before persisting even though
        // callers should pass only ids + amounts. A future caller
        // that hands the raw provider payload in won't leak email
        // / phone into the long-lived ledger.
        metadata: input.metadata
          ? (redactPii(input.metadata) as Record<string, unknown>)
          : null,
      };
      // For webhook-sourced rows, the partial unique index on
      // (event_type, provider_event_id) is the idempotency boundary —
      // ON CONFLICT DO NOTHING absorbs a duplicate delivery
      // gracefully. Non-webhook callers fall through to a plain
      // insert (no conflict target needed; their dedup is the
      // caller's concern).
      if (input.providerEventId) {
        await this.repo
          .createQueryBuilder()
          .insert()
          .into(FinancialEvent)
          .values(values)
          .orIgnore()
          .execute();
      } else {
        await this.repo.save(this.repo.create(values));
      }
    } catch (err) {
      this.logger.error(
        `[financial-audit] write failed event=${input.eventType} user=${input.userId ?? 'n/a'}: ${(err as Error).message}`,
      );
    }
  }
}
