import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { User } from '../modules/users/entities/user.entity';
import { MailService } from '../modules/mail/mail.service';
import { MailEvent } from '../modules/mail/mail.types';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { NotificationChannel } from '../common/types/enums';

/**
 * Cron: daily nudge to users whose streak is about to break.
 */
@Injectable()
export class StreakAtRiskJob {
  private readonly logger = new Logger(StreakAtRiskJob.name);
  private static readonly LOCK_KEY = 17_002;

  constructor(
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
  ) {}

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
    const dayKey = new Date().toISOString().slice(0, 10);

    const candidates = await this.usersRepo
      .createQueryBuilder('u')
      .where('u.streak_days > 0')
      .andWhere('u.last_active_at IS NOT NULL')
      .andWhere('u.last_active_at BETWEEN :lo AND :hi', {
        lo: lowerBound,
        hi: upperBound,
      })
      .take(500)
      .getMany();

    let queued = 0;
    for (const user of candidates) {
      if (!user.lastActiveAt) continue;
      const expiresAt = new Date(
        user.lastActiveAt.getTime() + 24 * 3600 * 1000,
      );

      await this.notifications
        .send({
          userId: user.id,
          channel: NotificationChannel.PUSH,
          title: `🔥 ${user.streakDays}-day streak at risk`,
          body: 'Answer one question today to keep your streak alive.',
          data: { type: 'streak_at_risk', streakDays: user.streakDays },
        })
        .catch(() => void 0);

      if (!user.email) continue;

      await this.mail.send(
        MailEvent.STREAK_AT_RISK,
        user.email,
        {
          recipientName: user.fullName ?? undefined,
          streakDays: user.streakDays,
          expiresAt,
        },
        {
          userId: user.id,
          dedupKey: `streak_at_risk:${user.id}:${dayKey}`,
          sync: false,
        },
      );
      queued += 1;
    }
    if (queued > 0) {
      this.logger.log(`[streak] queued ${queued} at-risk emails`);
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
