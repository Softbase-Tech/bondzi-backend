import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { User } from '../modules/users/entities/user.entity';
import { MailService } from '../modules/mail/mail.service';
import { MailEvent } from '../modules/mail/mail.types';

/**
 * Cron: daily nudge to users whose streak is about to break.
 *
 * Picks users where:
 *   - streak_days > 0 (we don't nudge people without an active streak)
 *   - last_active_at is between 18h and 26h ago (haven't studied today,
 *     and we want a window so the same user isn't emailed on
 *     consecutive ticks)
 *   - email IS NOT NULL (phone-only signups get a push instead via
 *     StreakService — this is the email companion)
 *
 * The 18–26h window assumes the streak resets at 24h since last activity
 * — sending at hour 18 gives the student ~6 hours to act. The upper
 * 26h bound caps the lookback so we don't email users who already broke
 * their streak yesterday (they get the "streak reset" path via streak.service).
 *
 * Postgres advisory lock keeps two worker replicas from double-sending.
 * Runs once a day in WORKER_MODE only.
 */
@Injectable()
export class StreakAtRiskJob {
  private readonly logger = new Logger(StreakAtRiskJob.name);
  private static readonly LOCK_KEY = 17_002;

  constructor(
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly mail: MailService,
  ) {}

  // Fire at 17:00 server time so a user in West Africa (UTC) gets the
  // email mid-evening — typical study window, still time to act before
  // the 24h reset.
  @Cron('0 17 * * *')
  async tick(): Promise<void> {
    if (process.env.WORKER_MODE !== 'true') return;
    await this.dataSource.transaction(async (em) => {
      const got = await this.tryAcquireAdvisoryLock(em);
      if (!got) {
        this.logger.log('[streak] another worker holds the lock; skipping');
        return;
      }
      await this.scan();
    });
  }

  private async scan(): Promise<void> {
    const now = Date.now();
    const lowerBound = new Date(now - 26 * 3600 * 1000);
    const upperBound = new Date(now - 18 * 3600 * 1000);

    // Stream in batches to avoid loading every active user into memory
    // when we scale. 500 per batch is generous for a daily job.
    const candidates = await this.usersRepo
      .createQueryBuilder('u')
      .where('u.streak_days > 0')
      .andWhere('u.email IS NOT NULL')
      .andWhere('u.last_active_at IS NOT NULL')
      .andWhere('u.last_active_at BETWEEN :lo AND :hi', {
        lo: lowerBound,
        hi: upperBound,
      })
      .take(500)
      .getMany();

    let sent = 0;
    for (const user of candidates) {
      if (!user.email || !user.lastActiveAt) continue;
      // The streak resets 24h after lastActiveAt — surface that as the
      // expiry the user is racing against.
      const expiresAt = new Date(user.lastActiveAt.getTime() + 24 * 3600 * 1000);
      await this.mail.send(MailEvent.STREAK_AT_RISK, user.email, {
        recipientName: user.fullName ?? undefined,
        streakDays: user.streakDays,
        expiresAt,
      });
      sent += 1;
    }
    if (sent > 0) {
      this.logger.log(`[streak] sent ${sent} at-risk emails`);
    }
  }

  private async tryAcquireAdvisoryLock(em: {
    query: (sql: string, params?: unknown[]) => Promise<{ got: boolean }[]>;
  }): Promise<boolean> {
    const rows = await em.query(
      'SELECT pg_try_advisory_xact_lock(1, $1) AS got',
      [StreakAtRiskJob.LOCK_KEY],
    );
    return rows[0]?.got === true;
  }
}
