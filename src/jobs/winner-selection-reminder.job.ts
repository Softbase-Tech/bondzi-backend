import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { WinnerSelectionService } from '../modules/leaderboard/winner-selection.service';
import { MailService } from '../modules/mail/mail.service';
import { MailEvent } from '../modules/mail/mail.types';
import { ExamType, LeaderboardPeriodType } from '../common/types/enums';

/**
 * Weekly cron that pokes the ops mailing list when one or more
 * leaderboard periods are still awaiting winner selection. The fix
 * for "I forgot to pick winners last week" — the dashboard alone
 * surfaces only the most recent period, so a missed week silently
 * disappears from the admin's attention.
 *
 * Schedule: Monday 09:00 UTC (09:00 Ghana — same TZ). Weekly
 * leaderboards close on Sunday night; Monday morning is the
 * earliest the new pool is meaningful.
 *
 * No-ops when:
 *   - `WORKER_MODE` is unset (web-tier instances skip)
 *   - the recipients list is empty (operator explicitly disabled)
 *   - there are no pending periods (clean week — nothing to nag)
 */
@Injectable()
export class WinnerSelectionReminderJob {
  private readonly logger = new Logger(WinnerSelectionReminderJob.name);

  constructor(
    private readonly winners: WinnerSelectionService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  @Cron('0 9 * * 1')
  async tick(): Promise<void> {
    if (process.env.WORKER_MODE !== 'true') return;
    try {
      await this.run();
    } catch (err) {
      this.logger.error(
        `[winner-reminder] scan failed: ${(err as Error).message}`,
      );
    }
  }

  async run(): Promise<{ pending: number; recipients: string[] }> {
    const recipients =
      this.config.get<string[]>('mail.winnerReminderRecipients') ?? [];
    if (recipients.length === 0) {
      this.logger.log('[winner-reminder] no recipients configured; skipping');
      return { pending: 0, recipients: [] };
    }

    const pending = await this.winners.listPendingPeriods({ limit: 50 });
    if (pending.length === 0) {
      this.logger.log('[winner-reminder] no pending periods; skipping');
      return { pending: 0, recipients };
    }

    const webUrl = this.config.get<string>('mail.webUrl') ?? '';
    const selectUrl = `${webUrl.replace(/\/$/, '')}/admin/winners`;

    // One email per recipient — we deliberately don't `bcc:` so each
    // inbox gets its own delivery receipt and Resend can track bounces
    // per address. Dedup key keys on the date + count so a redelivery
    // (cron rerun, manual /run) doesn't double-blast the inbox the
    // same morning.
    const dedupKey = `winner-reminder:${new Date().toISOString().slice(0, 10)}:${pending.length}`;
    const payload = {
      pendingPeriods: pending.map((p) => ({
        examType: this.examTypeLabel(p.examType),
        periodType: p.periodType,
        periodStart: p.periodStart,
        candidateCount: p.candidateCount,
      })),
      selectUrl,
    };

    for (const to of recipients) {
      await this.mail
        .send(MailEvent.WINNER_SELECTION_REMINDER, to, payload, {
          dedupKey: `${dedupKey}:${to}`,
        })
        .catch((err) =>
          this.logger.warn(
            `[winner-reminder] dispatch failed to=${to}: ${(err as Error).message}`,
          ),
        );
    }

    this.logger.log(
      `[winner-reminder] sent reminder to ${recipients.length} recipient(s) for ${pending.length} pending period(s)`,
    );
    return { pending: pending.length, recipients };
  }

  /** 'BECE' / 'WASSCE' / 'NOVDEC' display labels. */
  private examTypeLabel(t: ExamType): string {
    return t.toUpperCase();
  }
}

// Re-export the period-type enum for callers that need the union
// when constructing the payload. Keeps the cron self-contained
// without forcing them to dig into the leaderboard module.
export { LeaderboardPeriodType };
