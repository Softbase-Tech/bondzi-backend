import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PaymentAttempt } from './entities/payment-attempt.entity';
import {
  BillingInterval,
  PaymentAttemptStatus,
} from '../../common/types/enums';

/**
 * Input to `createPending`. All money fields are passed in already
 * normalised by the caller — this service doesn't compute prices or
 * apply discounts. It just persists the intent.
 */
export interface CreatePendingPaymentInput {
  userId: string;
  planId: string;
  billingInterval: BillingInterval | null;
  amountMinor: number;
  amountGhs: number;
  currency: string;
  provider: string;
  providerReference: string;
  promoCodeId?: string | null;
  discountAmount?: number | null;
  metadata?: Record<string, unknown>;
}

/**
 * Owns the `payment_attempts` table — every checkout attempt,
 * regardless of outcome. Created by `SubscriptionsService.initiate()`
 * BEFORE Paystack is called; transitioned by `verify()` or the webhook
 * handler.
 *
 * Service contract:
 *
 *   - `createPending` — write a fresh PENDING row. The unique index on
 *     `provider_reference` is the dedupe gate; the caller generates a
 *     fresh reference per attempt.
 *   - `markPaid` — atomic transition PENDING→PAID. Idempotent for
 *     replays (already-paid rows are returned as-is).
 *   - `markFailed` — atomic transition PENDING→FAILED, records the
 *     reason. Terminal.
 *   - `markRefunded` — atomic transition PAID→REFUNDED. Idempotent.
 *   - `findByReference` — webhook + verify lookup gate.
 *   - `linkSubscription` — back-fills subscription_id once the
 *     upstream subscription row exists.
 *   - `listForUser` — paginated history (user-facing screen + admin).
 *   - `sweepAbandoned` — cron-friendly: flip stale PENDING rows to
 *     ABANDONED so the admin UI doesn't show them as live forever.
 */
@Injectable()
export class PaymentAttemptsService {
  private readonly logger = new Logger(PaymentAttemptsService.name);

  constructor(
    @InjectRepository(PaymentAttempt)
    private readonly repo: Repository<PaymentAttempt>,
  ) {}

  async createPending(
    input: CreatePendingPaymentInput,
  ): Promise<PaymentAttempt> {
    const row = this.repo.create({
      userId: input.userId,
      planId: input.planId,
      billingInterval: input.billingInterval,
      amountMinor: input.amountMinor,
      amountGhs: input.amountGhs,
      currency: input.currency,
      provider: input.provider,
      providerReference: input.providerReference,
      promoCodeId: input.promoCodeId ?? null,
      discountAmount: input.discountAmount ?? null,
      status: PaymentAttemptStatus.PENDING,
      metadata: input.metadata ?? null,
    });
    return this.repo.save(row);
  }

  async findByReference(
    providerReference: string,
  ): Promise<PaymentAttempt | null> {
    return this.repo.findOne({ where: { providerReference } });
  }

  async findById(id: string): Promise<PaymentAttempt | null> {
    return this.repo.findOne({ where: { id } });
  }

  /**
   * Transition PENDING → PAID. Idempotent: if the row is already PAID,
   * just merges any new provider identifiers and returns — keeps
   * webhook retries cheap.
   */
  async markPaid(
    id: string,
    opts: {
      providerEventId?: string | null;
      providerCustomerId?: string | null;
    } = {},
  ): Promise<PaymentAttempt> {
    const row = await this.repo.findOneOrFail({ where: { id } });
    if (row.status === PaymentAttemptStatus.PAID) {
      if (opts.providerEventId && !row.providerEventId) {
        row.providerEventId = opts.providerEventId;
      }
      if (opts.providerCustomerId && !row.providerCustomerId) {
        row.providerCustomerId = opts.providerCustomerId;
      }
      return this.repo.save(row);
    }
    // Non-PENDING → PAID transitions (FAILED → PAID, ABANDONED → PAID)
    // are legal but worth surfacing for reconciliation. They happen
    // when verify pre-flips to FAILED on a provider-side
    // verifyTransaction non-success, then the authoritative
    // charge.success webhook arrives later. Webhook wins, but the
    // operator should see the state crossing in the log so
    // reconciliation jobs don't double-count.
    if (row.status !== PaymentAttemptStatus.PENDING) {
      this.logger.warn(
        `[payment-attempt] ${row.status} → PAID transition for attempt=${id} ref=${row.providerReference} — webhook overrode prior terminal state`,
      );
    }
    row.status = PaymentAttemptStatus.PAID;
    row.paidAt = new Date();
    if (opts.providerEventId) row.providerEventId = opts.providerEventId;
    if (opts.providerCustomerId) {
      row.providerCustomerId = opts.providerCustomerId;
    }
    return this.repo.save(row);
  }

  async markFailed(id: string, reason: string): Promise<PaymentAttempt> {
    const row = await this.repo.findOneOrFail({ where: { id } });
    // Don't overwrite a paid / refunded terminal state — those took
    // precedence (e.g. webhook lands BEFORE a stale verify failure).
    if (
      row.status === PaymentAttemptStatus.PAID ||
      row.status === PaymentAttemptStatus.REFUNDED
    ) {
      return row;
    }
    row.status = PaymentAttemptStatus.FAILED;
    row.failedAt = new Date();
    row.failureReason = reason;
    return this.repo.save(row);
  }

  /**
   * Convenience wrapper used by the initiate path: when the provider
   * call throws AFTER the pending row was already persisted, the
   * caller doesn't have the id yet — only the reference it generated.
   * Looks up by reference and delegates to `markFailed`; a no-op if
   * the row has somehow vanished (db rollback, manual delete) so the
   * provider error surfaces uncluttered by a second exception.
   */
  async markFailedByReference(
    providerReference: string,
    reason: string,
  ): Promise<PaymentAttempt | null> {
    const row = await this.repo.findOne({ where: { providerReference } });
    if (!row) return null;
    return this.markFailed(row.id, reason);
  }

  async markRefunded(id: string): Promise<PaymentAttempt> {
    const row = await this.repo.findOneOrFail({ where: { id } });
    if (row.status === PaymentAttemptStatus.REFUNDED) return row;
    row.status = PaymentAttemptStatus.REFUNDED;
    row.refundedAt = new Date();
    return this.repo.save(row);
  }

  async linkSubscription(id: string, subscriptionId: string): Promise<void> {
    await this.repo.update({ id }, { subscriptionId });
  }

  /**
   * Paginated history for the authenticated user. Hot column is
   * `initiated_at DESC`, covered by the
   * `idx_payment_attempts_user_initiated` composite index.
   */
  async listForUser(
    userId: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<{ items: PaymentAttempt[]; total: number }> {
    const limit = Math.min(100, Math.max(1, opts.limit ?? 25));
    const offset = Math.max(0, opts.offset ?? 0);
    const [items, total] = await this.repo.findAndCount({
      where: { userId },
      relations: ['plan'],
      order: { initiatedAt: 'DESC' },
      take: limit,
      skip: offset,
    });
    return { items, total };
  }

  /**
   * Admin-side list — paginated, optionally filtered by status or by
   * the `duplicate_plus` alarm flag. Used by /admin/payments.
   *
   * The `alarm: 'duplicate_plus'` filter surfaces rows where
   * `metadata.alarmDuplicatePlus = true` — i.e. the user was charged
   * for Plus on a level they already owned. The corresponding
   * Paystack refund must be issued manually; the partial index
   * `idx_payment_attempts_alarm_duplicate_plus` (migration 1910)
   * supports this filter in O(1).
   */
  async listAll(
    opts: {
      limit?: number;
      offset?: number;
      status?: PaymentAttemptStatus;
      alarm?: 'duplicate_plus';
    } = {},
  ): Promise<{ items: PaymentAttempt[]; total: number }> {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const offset = Math.max(0, opts.offset ?? 0);
    const qb = this.repo
      .createQueryBuilder('pa')
      .leftJoinAndSelect('pa.plan', 'plan')
      .leftJoinAndSelect('pa.user', 'user')
      // Property path, not the raw column: with joins + take/skip,
      // TypeORM paginates through a DISTINCT subquery where raw
      // snake_case columns don't exist — Postgres rejects the query.
      .orderBy('pa.createdAt', 'DESC')
      .take(limit)
      .skip(offset);
    if (opts.status) qb.andWhere('pa.status = :st', { st: opts.status });
    if (opts.alarm === 'duplicate_plus') {
      qb.andWhere(`pa.metadata->>'alarmDuplicatePlus' = 'true'`);
    }
    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }

  /**
   * Sweep stale PENDING rows to ABANDONED. Default cut-off is 24h —
   * any pending row that hasn't seen a webhook in 24h is almost
   * certainly an abandoned checkout (closed the tab, network drop,
   * changed their mind). Run by the renewal cron.
   */
  async sweepAbandoned(olderThanMs = 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const result = await this.repo
      .createQueryBuilder()
      .update(PaymentAttempt)
      .set({
        status: PaymentAttemptStatus.ABANDONED,
        abandonedAt: () => 'NOW()',
      })
      .where('status = :pending', { pending: PaymentAttemptStatus.PENDING })
      .andWhere('initiated_at < :cutoff', { cutoff })
      .execute();
    const affected = result.affected ?? 0;
    if (affected > 0) {
      this.logger.log(
        `[payments] swept ${affected} pending attempts to abandoned (older than ${olderThanMs / 3600_000}h)`,
      );
    }
    return affected;
  }
}
