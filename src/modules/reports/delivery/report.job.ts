import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { LockKey } from '../../../jobs/advisory-lock-keys';
import { SnapshotService } from '../snapshot/snapshot.service';
import { DailyRenderer } from '../render/daily.renderer';
import { ReportDeliveryService } from './report-delivery.service';
import type { ReportType } from '../entities/report-delivery.entity';
import { resolveRange, shiftIso, type DateRange } from '../date-range.util';

/** Retry backoff for a failed send, per §10.2. */
const RETRY_DELAYS_MS = [60_000, 120_000, 240_000];

/**
 * The scheduled reports.
 *
 * Follows the house recipe exactly: `@Cron` + in-handler `WORKER_MODE`
 * guard + a Postgres advisory lock. Not BullMQ repeatables — the codebase
 * has zero of those, and `worker.module.ts` is a pass-through of
 * `AppModule`, so **both containers arm every timer**. The WORKER_MODE
 * check is what stops the API container running these; the advisory lock
 * is what would stop a second worker replica.
 *
 * `timeZone: 'UTC'` is set explicitly on every handler. Ghana is UTC+0 so
 * it changes nothing today — but the periods these cover are defined as
 * UTC calendar days, and leaving the schedule to the container's local
 * zone would silently shift the boundary if that ever stopped being UTC.
 */
@Injectable()
export class ReportJob {
  private readonly logger = new Logger(ReportJob.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly snapshots: SnapshotService,
    private readonly renderer: DailyRenderer,
    private readonly deliveries: ReportDeliveryService,
    private readonly config: ConfigService,
  ) {}

  @Cron('0 6 * * *', { timeZone: 'UTC' })
  async daily(): Promise<void> {
    await this.guarded(LockKey.REPORT_DAILY, () => this.runReport('daily'));
  }

  /**
   * Runs one report end to end. Public so the admin endpoint can trigger
   * it for a specific period without duplicating the flow.
   */
  async runReport(
    type: ReportType,
    opts: { date?: string; force?: boolean } = {},
  ): Promise<{ status: 'sent' | 'skipped' | 'failed'; range: DateRange }> {
    const range = opts.date
      ? { start: opts.date, end: opts.date }
      : resolveRange(type, new Date());

    const recipients = this.deliveries.recipientsFor(type);
    if (recipients.length === 0) {
      // Not an error: an empty recipient list is how a report is turned
      // off for one cadence without touching the others.
      this.logger.log(`[reports] ${type} has no recipients; skipping`);
      return { status: 'skipped', range };
    }

    const claim = await this.deliveries.claim(
      type,
      range,
      recipients,
      opts.force,
    );
    if (claim.alreadySent) {
      this.logger.log(`[reports] ${type} ${range.start} already handled`);
      return { status: 'skipped', range };
    }

    try {
      // Backfill rather than report a hole. A day the box was down still
      // gets computed, marked so the renderer can dash what it could not
      // reconstruct.
      await this.snapshots.ensureRange(range);

      // Seven days of context for deltas and sparklines. The window is
      // read, not required — fewer days simply widens the dashes.
      const history = await this.snapshots.load({
        start: shiftIso(range.start, -6),
        end: range.end,
      });
      const today = history.find(
        (h) => String(h.snapshotDate).slice(0, 10) === range.start,
      );
      if (!today)
        throw new Error(
          `snapshot for ${range.start} missing after ensureRange`,
        );

      const rendered = this.renderer.render(today, history);
      await this.withRetries(() =>
        this.deliveries.send(type, range, recipients, rendered, opts.force),
      );
      await this.deliveries.markSent(type, range);
      await this.pingHeartbeat();
      this.logger.log(
        `[reports] ${type} ${range.start} sent to ${recipients.length} recipient(s)`,
      );
      return { status: 'sent', range };
    } catch (err) {
      await this.deliveries.markFailed(type, range, (err as Error).message);
      return { status: 'failed', range };
    }
  }

  /**
   * A missed report is silence, and silence reads exactly like a quiet
   * day. The heartbeat converts "no email" into an alert from a service
   * that is not this one — which is the only kind of alert that can
   * survive this service being down.
   */
  private async pingHeartbeat(): Promise<void> {
    const url = this.config.get<string>('reports.heartbeatUrl');
    if (!url) return;
    try {
      await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5_000) });
    } catch (err) {
      // Never fail a delivered report because the heartbeat was
      // unreachable — the email is the product, the ping is telemetry.
      this.logger.warn(
        `[reports] heartbeat ping failed: ${(err as Error).message}`,
      );
    }
  }

  private async withRetries(fn: () => Promise<void>): Promise<void> {
    let lastErr: unknown;
    for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
      try {
        await fn();
        return;
      } catch (err) {
        lastErr = err;
        const delay = RETRY_DELAYS_MS[i];
        if (delay === undefined) break;
        this.logger.warn(
          `[reports] send attempt ${i + 1} failed (${(err as Error).message}); retrying in ${delay / 1000}s`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  private async guarded(
    lockKey: number,
    fn: () => Promise<unknown>,
  ): Promise<void> {
    if (process.env.WORKER_MODE !== 'true') return;
    if (this.config.get<boolean>('reports.enabled') !== true) {
      this.logger.log('[reports] REPORT_ENABLED=false; skipping');
      return;
    }
    await this.dataSource.transaction(async (em) => {
      const rows = await em.query<{ got: boolean }[]>(
        'SELECT pg_try_advisory_xact_lock(1, $1) AS got',
        [lockKey],
      );
      if (rows[0]?.got !== true) {
        this.logger.log('[reports] another worker holds the lock; skipping');
        return;
      }
      await fn();
    });
  }
}
