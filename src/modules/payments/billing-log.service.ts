import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BillingLog } from './entities/billing-log.entity';
import { BillingLogProcessStatus } from '../../common/types/enums';
import { AdminAlertService } from '../mail/admin-alert.service';

export interface RecordBillingLogInput {
  provider: string;
  eventType: string;
  providerEventId: string;
  reference?: string | null;
  userId?: string | null;
  paymentAttemptId?: string | null;
  subscriptionId?: string | null;
  rawPayload: Record<string, unknown>;
  signature?: string | null;
  normalized?: Record<string, unknown> | null;
  occurredAt?: Date | null;
}

/**
 * Append-only sink for webhook events.
 *
 * Every Paystack webhook (and, in the future, any other provider's
 * webhooks) lands here FIRST — before any downstream effect is
 * applied. The verbatim payload is preserved so disputes can be
 * reconstructed; the `process_status` column records the outcome of
 * downstream processing so the admin can surface
 * `no_matching_payment` events as security alarms.
 *
 * Idempotency: `(provider, provider_event_id)` is UNIQUE in the DB.
 * `record()` returns the existing row on conflict — Paystack's retry
 * machinery (4-hour exponential backoff for failed deliveries) is
 * thereby a no-op for already-processed events.
 */
@Injectable()
export class BillingLogService {
  private readonly logger = new Logger(BillingLogService.name);

  constructor(
    @InjectRepository(BillingLog)
    private readonly repo: Repository<BillingLog>,
    private readonly adminAlert: AdminAlertService,
  ) {}

  /**
   * Persist a webhook event. Returns the row regardless of whether
   * this was a new insert or an idempotent match — the caller uses
   * `wasDuplicate` to decide whether to skip downstream processing.
   *
   * Implemented with `INSERT … ON CONFLICT DO NOTHING RETURNING *`
   * inside a single round-trip, with a fallback SELECT when the
   * `RETURNING` path returns empty (the conflict case under
   * Postgres semantics).
   */
  async record(
    input: RecordBillingLogInput,
  ): Promise<{ row: BillingLog; wasDuplicate: boolean }> {
    // Try insert first. ON CONFLICT (provider, provider_event_id) DO
    // NOTHING — the unique index is the dedupe boundary.
    //
    // The values payload is cast through `as unknown` to satisfy
    // TypeORM's `_QueryDeepPartialEntity` constraint on jsonb columns
    // — the runtime shape is exactly what the column expects, but the
    // compile-time constraint refuses a plain `Record<string, unknown>`
    // without explicit acknowledgment that we're not nesting any
    // entity relations into it.
    const values: Record<string, unknown> = {
      provider: input.provider,
      eventType: input.eventType,
      providerEventId: input.providerEventId,
      reference: input.reference ?? null,
      userId: input.userId ?? null,
      paymentAttemptId: input.paymentAttemptId ?? null,
      subscriptionId: input.subscriptionId ?? null,
      rawPayload: input.rawPayload,
      signature: input.signature ?? null,
      normalized: input.normalized ?? null,
      occurredAt: input.occurredAt ?? null,
    };
    const inserted = await this.repo
      .createQueryBuilder()
      .insert()
      .into(BillingLog)
      .values(values)
      .orIgnore()
      .returning('*')
      .execute();

    const insertedRow = (inserted.raw as BillingLog[] | undefined)?.[0];
    if (insertedRow) {
      return { row: insertedRow, wasDuplicate: false };
    }

    // Conflict path — fetch the existing row.
    const existing = await this.repo.findOne({
      where: {
        provider: input.provider,
        providerEventId: input.providerEventId,
      },
    });
    if (!existing) {
      // ON CONFLICT swallowed the insert but the row vanished — would
      // only happen under a race with deletion (we never delete). Log
      // and surface as a fresh row so the caller doesn't crash.
      this.logger.error(
        `[billing-log] conflict on (${input.provider}, ${input.providerEventId}) but no matching row found`,
      );
      throw new Error('billing-log record vanished after conflict');
    }
    return { row: existing, wasDuplicate: true };
  }

  /**
   * Mark the downstream processing outcome of an already-recorded
   * webhook. Called by the webhook handler after it's done resolving
   * the event to a payment / subscription.
   */
  async markProcessed(
    id: string,
    status: BillingLogProcessStatus,
    opts: {
      paymentAttemptId?: string | null;
      subscriptionId?: string | null;
      userId?: string | null;
      error?: string | null;
    } = {},
  ): Promise<void> {
    // Plain column-keyed object — avoid `Partial<BillingLog>` because
    // TypeORM's `_QueryDeepPartialEntity` constraint stumbles on the
    // entity's relation fields. The shape below maps only to columns.
    const updates: Record<string, unknown> = {
      processStatus: status,
      processedAt: new Date(),
    };
    if (opts.paymentAttemptId !== undefined) {
      updates.paymentAttemptId = opts.paymentAttemptId;
    }
    if (opts.subscriptionId !== undefined) {
      updates.subscriptionId = opts.subscriptionId;
    }
    if (opts.userId !== undefined) {
      updates.userId = opts.userId;
    }
    if (opts.error !== undefined) {
      updates.processError = opts.error;
    }
    await this.repo.update({ id }, updates);
    if (status === BillingLogProcessStatus.NO_MATCHING_PAYMENT) {
      this.logger.warn(
        `[billing-log] no_matching_payment id=${id} — Paystack webhook references a payment we never initiated`,
      );
      // Money-shaped event with no matching checkout is exactly the
      // "user paid, nothing recorded" incident class — page the
      // operator instead of waiting for the student to complain.
      void this.adminAlert
        .send(
          'Payment webhook with NO matching checkout',
          [
            'A provider webhook referenced a payment this backend never initiated.',
            `billing_log id: ${id}`,
            `error: ${opts.error ?? 'n/a'}`,
            '',
            'Likely causes: payment made via a Paystack payment page/link,',
            'an old deployment initialized the charge, or the mobile app is',
            'pointing at a different API. Triage in /admin/billing-log.',
          ].join('\n'),
        )
        .catch((err: Error) =>
          this.logger.error(`[billing-log] alert send failed: ${err.message}`),
        );
    } else if (status === BillingLogProcessStatus.ERROR) {
      this.logger.error(
        `[billing-log] processing error id=${id} error=${opts.error ?? 'unknown'}`,
      );
    }
  }

  /**
   * Admin-facing list — paginated, ordered by received_at DESC.
   * Status filter lets the operator zero in on alarms / errors.
   */
  async listAll(
    opts: {
      limit?: number;
      offset?: number;
      processStatus?: BillingLogProcessStatus;
    } = {},
  ): Promise<{ items: BillingLog[]; total: number }> {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const offset = Math.max(0, opts.offset ?? 0);
    const where = opts.processStatus
      ? { processStatus: opts.processStatus }
      : {};
    const [items, total] = await this.repo.findAndCount({
      where,
      order: { receivedAt: 'DESC' },
      take: limit,
      skip: offset,
    });
    return { items, total };
  }
}
