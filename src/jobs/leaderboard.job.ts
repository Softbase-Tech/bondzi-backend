import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LeaderboardService } from '../modules/leaderboard/leaderboard.service';
import {
  PASSMASTER_TIMEZONE,
  accraMondayIso,
} from '../common/utils/timezone.util';

@Injectable()
export class LeaderboardJob {
  private readonly logger = new Logger(LeaderboardJob.name);

  constructor(private readonly leaderboard: LeaderboardService) {}

  // Every Monday 00:05 Africa/Accra — roll the week.
  @Cron('5 0 * * 1', { timeZone: PASSMASTER_TIMEZONE })
  async snapshot(): Promise<void> {
    const weekStart = accraMondayIso();
    this.logger.log(`[leaderboard] snapshotting week ${weekStart}`);
    await this.leaderboard.snapshotWeek(weekStart);
  }

  // Every hour — recompute cached top-100 (Phase 1.1 will back this with a mat view).
  @Cron(CronExpression.EVERY_HOUR)
  async warmCache(): Promise<void> {
    // no-op for MVP — cache warms naturally on read.
  }
}
