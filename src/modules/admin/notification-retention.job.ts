import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AdminNotificationsService } from './admin-notifications.service';

/**
 * Daily cron that trims the `notifications` table to a 90-day
 * rolling window. The notifications log is the operational audit
 * trail for every push the platform has ever sent — useful for
 * tracking down a "did this user actually get my note?" question.
 * Beyond 90 days the storage cost outweighs the operational value,
 * so we delete.
 *
 * Pattern matches the rest of the cron handlers in `src/jobs/*.job.ts`
 * — WORKER_MODE guard so only one process runs the cron, and the
 * underlying service emits its own log line with the deleted-row
 * count.
 */
@Injectable()
export class NotificationRetentionJob {
  private readonly logger = new Logger(NotificationRetentionJob.name);
  private static readonly RETENTION_DAYS = 90;

  constructor(private readonly adminNotifications: AdminNotificationsService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async tick(): Promise<void> {
    // Only the WORKER process should execute crons — the web tier
    // imports the same module but is gated off via env. Mirrors the
    // existing /jobs/*.job.ts handlers.
    if (process.env.WORKER_MODE !== 'true') return;
    try {
      const pruned = await this.adminNotifications.pruneOlderThan(
        NotificationRetentionJob.RETENTION_DAYS,
      );
      if (pruned === 0) {
        this.logger.log('[notifications] retention scan — nothing to prune');
      }
    } catch (err) {
      this.logger.error(
        `[notifications] retention scan failed: ${(err as Error).message}`,
      );
    }
  }
}
