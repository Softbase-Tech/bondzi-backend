import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LeaderboardService } from '../modules/leaderboard/leaderboard.service';
import { BONDZI_TIMEZONE, accraMondayIso } from '../common/utils/timezone.util';

@Injectable()
export class LeaderboardJob {
  private readonly logger = new Logger(LeaderboardJob.name);

  constructor(private readonly leaderboard: LeaderboardService) {}

  // Every Monday 00:05 Africa/Accra — roll the week.
  @Cron('5 0 * * 1', { timeZone: BONDZI_TIMEZONE })
  async snapshot(): Promise<void> {
    // Worker-only — see ai-budget-alert.job.ts for the explanation.
    if (process.env.WORKER_MODE !== 'true') return;
    const weekStart = accraMondayIso();
    this.logger.log(`[leaderboard] snapshotting week ${weekStart}`);
    await this.leaderboard.snapshotWeek(weekStart);
  }

  // Every hour — recompute cached top-100 (Phase 1.1 will back this with a mat view).
  // Not async: the body is currently a no-op + worker gate. Drop `async` to
  // avoid require-await; promote back when there's real work to await.
  @Cron(CronExpression.EVERY_HOUR)
  warmCache(): void {
    if (process.env.WORKER_MODE !== 'true') return;
    // no-op for MVP — cache warms naturally on read.
  }
}
