import { Injectable, Logger } from '@nestjs/common';
import { WinnerSelectionService } from '../modules/leaderboard/winner-selection.service';
import { ExamType, LeaderboardPeriodType } from '../common/types/enums';

/**
 * Spec §1.2 / §7.2: weekly/monthly winner selection. Admin-triggered — never
 * scheduled, per the product rule that every payout is reviewed by a human
 * before XP leaves the vault.
 *
 * This file is the thin wrapper the spec's jobs/ directory layout references;
 * the selection engine itself lives in WinnerSelectionService.
 */
@Injectable()
export class LeaderboardWinnerJob {
  private readonly logger = new Logger(LeaderboardWinnerJob.name);

  constructor(private readonly winners: WinnerSelectionService) {}

  /**
   * Run from the admin endpoint only. Returns the summary straight through.
   */
  async run(
    examType: ExamType,
    periodType: LeaderboardPeriodType,
    periodStart: string,
  ) {
    this.logger.log(
      `[winners] admin-triggered selection ${examType}/${periodType}/${periodStart}`,
    );
    return this.winners.selectWinners({ examType, periodType, periodStart });
  }
}
