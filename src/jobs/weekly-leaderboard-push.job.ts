import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { User } from '../modules/users/entities/user.entity';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { NotificationChannel } from '../common/types/enums';

/**
 * Monday 09:00 Accra — announce the fresh weekly leaderboard on push.
 * Companion to the existing weekly-digest.job.ts (email, Sunday 08:00);
 * the two run on different days so a user opted into both doesn't get
 * hammered on the weekend.
 *
 * Segmentation:
 *   - push_reminders_enabled = true (opt-out)
 *   - has at least one device token (EXISTS clause)
 *   - is_active, not deleted
 *
 * Deliberately does NOT filter on streak / recent activity — the
 * "new week!" framing works for lapsed users too, and re-engagement
 * is the whole point of this push. Rate-limited via advisory lock so
 * a worker restart on Monday morning doesn't double-send.
 */
@Injectable()
export class WeeklyLeaderboardPushJob {
  private readonly logger = new Logger(WeeklyLeaderboardPushJob.name);
  private static readonly LOCK_KEY = 17_004;

  constructor(
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    private readonly notifications: NotificationsService,
    private readonly dataSource: DataSource,
  ) {}

  @Cron('0 9 * * 1', { timeZone: 'Africa/Accra' })
  async tick(): Promise<void> {
    if (process.env.WORKER_MODE !== 'true') return;
    await this.dataSource.transaction(async (em) => {
      const got = await this.tryAcquireAdvisoryLock(em);
      if (!got) {
        this.logger.log(
          '[weekly-leaderboard-push] another worker holds the lock; skipping',
        );
        return;
      }
      await this.scan();
    });
  }

  private async scan(): Promise<void> {
    const candidates = await this.usersRepo
      .createQueryBuilder('u')
      .where('u.push_reminders_enabled = true')
      .andWhere('u.is_active = true')
      .andWhere('u.deleted_at IS NULL')
      .andWhere(`EXISTS (SELECT 1 FROM user_devices d WHERE d.user_id = u.id)`)
      .take(5000)
      .getMany();

    let queued = 0;
    for (const user of candidates) {
      await this.notifications
        .send({
          userId: user.id,
          channel: NotificationChannel.PUSH,
          title: 'New week, fresh leaderboard 🏆',
          body: 'First to earn XP grabs the top spot this week.',
          data: { type: 'weekly_leaderboard' },
        })
        .catch(() => void 0);
      queued += 1;
    }
    if (queued > 0) {
      this.logger.log(
        `[weekly-leaderboard-push] queued ${queued} push notifications`,
      );
    }
  }

  private async tryAcquireAdvisoryLock(em: {
    query: (sql: string, params?: unknown[]) => Promise<{ got: boolean }[]>;
  }): Promise<boolean> {
    const rows = await em.query(
      'SELECT pg_try_advisory_xact_lock(1, $1) AS got',
      [WeeklyLeaderboardPushJob.LOCK_KEY],
    );
    return rows[0]?.got === true;
  }
}
