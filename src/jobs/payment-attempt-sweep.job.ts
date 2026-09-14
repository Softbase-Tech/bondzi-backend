import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { PaymentAttemptsService } from '../modules/payments/payment-attempts.service';
import { LockKey } from './advisory-lock-keys';

/**
 * Cron: flip stale PENDING payment attempts to ABANDONED.
 *
 * `PaymentAttemptsService.sweepAbandoned()` has existed since payment
 * attempts were introduced — its doc comment even says "run by the renewal
 * cron" — but nothing ever called it. The consequence is quiet and
 * compounding: a row is written to `payment_attempts` *before* Paystack is
 * contacted, so every closed tab, dropped connection and changed mind
 * leaves a `pending` row that never reaches a terminal state.
 *
 * That matters beyond tidiness. Payment success rate is measured over
 * terminal attempts (`paid` / `failed` / `abandoned`); leaving abandonment
 * permanently `pending` shrinks the denominator, so the reported success
 * rate drifts upward exactly as checkout abandonment gets worse — the
 * metric moves the wrong way at the moment you most need it.
 *
 * 24h is the cut-off `sweepAbandoned` already defaults to: Paystack
 * webhooks for a real charge arrive in seconds, and its own retry schedule
 * is exhausted long before a day has passed.
 *
 * Runs at 00:05 UTC, before the 00:15 reporting snapshot, so a day's
 * attempts are settled by the time that day's numbers are computed.
 */
@Injectable()
export class PaymentAttemptSweepJob {
  private readonly logger = new Logger(PaymentAttemptSweepJob.name);

  constructor(
    private readonly attempts: PaymentAttemptsService,
    private readonly dataSource: DataSource,
  ) {}

  @Cron('5 0 * * *', { timeZone: 'UTC' })
  async tick(): Promise<void> {
    // Both containers import AppModule, so both arm this timer.
    if (process.env.WORKER_MODE !== 'true') return;

    await this.dataSource.transaction(async (em) => {
      const rows = await em.query<{ got: boolean }[]>(
        'SELECT pg_try_advisory_xact_lock(1, $1) AS got',
        [LockKey.PAYMENT_ATTEMPT_SWEEP],
      );
      if (rows[0]?.got !== true) {
        this.logger.log('[payments] another worker holds the sweep lock');
        return;
      }
      try {
        const swept = await this.attempts.sweepAbandoned();
        this.logger.log(
          `[payments] attempt sweep complete: ${swept} abandoned`,
        );
      } catch (err) {
        // Never let a sweep failure abort the transaction in a way that
        // looks like a lock problem — log and move on; tomorrow's run
        // picks up anything missed, since the predicate is age-based.
        this.logger.error(
          `[payments] attempt sweep failed: ${(err as Error).message}`,
        );
      }
    });
  }
}
