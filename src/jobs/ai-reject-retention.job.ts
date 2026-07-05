import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RejectLogService } from '../modules/ai/reject-log.service';

/**
 * Weekly cron that trims the AI reject log to a 30-day rolling
 * window. The RAW log holds truncated model output blobs so an
 * unbounded retention would grow into a hot table over months —
 * beyond 30 days the operational value is negligible because the
 * weekly aggregate (`ai_generation_reject_agg`) captures the
 * failure-trend information at a much smaller footprint AND is
 * retained indefinitely by design.
 *
 * Weekly (not daily) is deliberate: prune volume is small and it
 * doesn't need real-time freshness — the failure-trend dashboard
 * reads the aggregate. Runs Monday 03:00 to sit next to the other
 * quiet-time cron handlers.
 *
 * Pattern matches src/modules/admin/notification-retention.job.ts —
 * WORKER_MODE guard so only the worker container runs it (the web
 * tier imports the same module).
 */
@Injectable()
export class AiRejectRetentionJob {
  private readonly logger = new Logger(AiRejectRetentionJob.name);
  private static readonly RETENTION_DAYS = 30;

  constructor(private readonly rejectLog: RejectLogService) {}

  @Cron(CronExpression.EVERY_WEEK)
  async tick(): Promise<void> {
    if (process.env.WORKER_MODE !== 'true') return;
    try {
      const pruned = await this.rejectLog.pruneRawOlderThanDays(
        AiRejectRetentionJob.RETENTION_DAYS,
      );
      if (pruned === 0) {
        this.logger.log('[ai-reject-log] retention scan — nothing to prune');
      }
    } catch (err) {
      this.logger.error(
        `[ai-reject-log] retention scan failed: ${(err as Error).message}`,
      );
    }
  }
}
