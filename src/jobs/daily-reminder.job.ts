import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { User } from '../modules/users/entities/user.entity';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { MailService } from '../modules/mail/mail.service';
import { MailEvent } from '../modules/mail/mail.types';
import { NotificationChannel } from '../common/types/enums';
import { accraDateIso } from '../common/utils/timezone.util';

/**
 * Daily practice reminder push. Fires at 10:00 Africa/Accra — late
 * enough that most students are up, early enough that we're not
 * competing with evening study noise from the 17:00 streak-at-risk
 * job. The two crons deliberately don't overlap on the same day
 * (streak-at-risk targets an 8h "risk window" that starts ~18h after
 * last_active_at, so a user reminded here at 10 who studies at 11
 * won't get another push at 17).
 *
 * Segmentation (subject to the push_reminders_enabled opt-out):
 *   - streak_days > 0 OR last_active_at within the past 3 days —
 *     retain-not-acquire; we don't want to badger users who have
 *     never engaged
 *   - last_study_date < accra_today — hasn't studied yet today
 *   - deleted_at IS NULL AND is_active
 *   - has at least one row in user_devices (otherwise the send would
 *     no-op and just cost us the DB read)
 *
 * The dedup key on the notification row prevents a same-day retrigger
 * if the cron runs twice (e.g. worker restart).
 */
@Injectable()
export class DailyReminderJob {
  private readonly logger = new Logger(DailyReminderJob.name);
  private static readonly LOCK_KEY = 17_003;

  constructor(
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
    private readonly dataSource: DataSource,
  ) {}

  @Cron('0 10 * * *', { timeZone: 'Africa/Accra' })
  async tick(): Promise<void> {
    if (process.env.WORKER_MODE !== 'true') return;
    await this.dataSource.transaction(async (em) => {
      const got = await this.tryAcquireAdvisoryLock(em);
      if (!got) {
        this.logger.log(
          '[daily-reminder] another worker holds the lock; skipping',
        );
        return;
      }
      await this.scan();
      await this.scanEmailFallback();
    });
  }

  private async scan(): Promise<void> {
    const today = accraDateIso();
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000);

    const candidates = await this.usersRepo
      .createQueryBuilder('u')
      .where('u.push_reminders_enabled = true')
      .andWhere('u.is_active = true')
      .andWhere('u.deleted_at IS NULL')
      .andWhere('(u.streak_days > 0 OR u.last_active_at >= :threeDaysAgo)', {
        threeDaysAgo,
      })
      .andWhere('(u.last_study_date IS NULL OR u.last_study_date < :today)', {
        today,
      })
      // Only users we can actually reach — cheaper to join here than
      // fan the send call out to Firebase and let it no-op per token.
      .andWhere(`EXISTS (SELECT 1 FROM user_devices d WHERE d.user_id = u.id)`)
      .take(1000)
      .getMany();

    let queued = 0;
    for (const user of candidates) {
      const streak = user.streakDays ?? 0;
      const title =
        streak > 0
          ? `Ready to keep your ${streak}-day streak going?`
          : "Today's your day — one session gets you started.";
      const body =
        streak > 0
          ? 'One session today keeps the streak alive.'
          : 'Pick a subject and get back on track.';

      await this.notifications
        .send({
          userId: user.id,
          channel: NotificationChannel.PUSH,
          title,
          body,
          data: { type: 'daily_reminder', streakDays: streak },
        })
        .catch(() => void 0);
      queued += 1;
    }
    if (queued > 0) {
      this.logger.log(`[daily-reminder] queued ${queued} push notifications`);
    }
  }

  /**
   * EMAIL fallback for push-unreachable users (premium re-engagement
   * plan): the push scan above deliberately requires a user_devices
   * row, which excludes every web signup with no app install — exactly
   * the users re-engagement exists for. This leg reaches them by mail,
   * with COST as the first-class constraint (Resend free tier is
   * 3k/month):
   *
   *   • per-user cadence: at most every 3rd day — a stable hash of the
   *     user id spreads users across a 3-day rota, so daily runs never
   *     email the same person twice in the window and load stays even.
   *   • hard per-run cap: REENGAGEMENT_EMAIL_DAILY_CAP (default 150) —
   *     a growth spike raises the backlog, never the bill.
   *   • per-user gates ride MailService: email_streak_nudges_enabled
   *     (the "study nudges" category), bounce state, and a same-day
   *     dedup key.
   *
   * Reachability, not signup platform, is the routing rule: the moment
   * a web user grants browser push (or installs the app), a device row
   * appears and they graduate from this leg to the push leg above.
   */
  private async scanEmailFallback(): Promise<void> {
    const today = accraDateIso();
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    const cap = Math.max(
      0,
      Number(process.env.REENGAGEMENT_EMAIL_DAILY_CAP ?? 150),
    );
    if (cap === 0) return; // env kill switch

    const candidates = await this.usersRepo
      .createQueryBuilder('u')
      .where('u.is_active = true')
      .andWhere('u.deleted_at IS NULL')
      .andWhere('u.email IS NOT NULL')
      .andWhere('u.email_bounced_at IS NULL')
      .andWhere('u.email_streak_nudges_enabled = true')
      .andWhere('(u.streak_days > 0 OR u.last_active_at >= :threeDaysAgo)', {
        threeDaysAgo,
      })
      .andWhere('(u.last_study_date IS NULL OR u.last_study_date < :today)', {
        today,
      })
      // The inverse of the push scan: ONLY users we cannot push to.
      .andWhere(
        `NOT EXISTS (SELECT 1 FROM user_devices d WHERE d.user_id = u.id)`,
      )
      .take(cap * 4) // headroom before the rota filter thins the set
      .getMany();

    // 3-day rota: stable per-user bucket vs today's bucket.
    const dayIndex = Math.floor(Date.now() / 86_400_000) % 3;
    const due = candidates
      .filter((u) => DailyReminderJob.rotaBucket(u.id) === dayIndex)
      .slice(0, cap);

    let queued = 0;
    for (const user of due) {
      if (!user.email) continue;
      await this.mail
        .send(
          MailEvent.STUDY_REMINDER,
          user.email,
          {
            recipientName: user.fullName ?? undefined,
            streakDays: user.streakDays ?? 0,
            unsubscribeUrl: user.emailUnsubscribeToken
              ? this.mail.buildUnsubscribeUrl(user.emailUnsubscribeToken)
              : undefined,
          },
          {
            userId: user.id,
            dedupKey: `study_reminder:${user.id}:${today}`,
            sync: false,
          },
        )
        .catch(() => void 0);
      queued += 1;
    }
    if (queued > 0) {
      this.logger.log(
        `[daily-reminder] queued ${queued} fallback emails (cap=${cap}, rota=${dayIndex})`,
      );
    }
  }

  /** Stable 0–2 bucket from the uuid (FNV-1a over the string). */
  private static rotaBucket(userId: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < userId.length; i++) {
      h ^= userId.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0) % 3;
  }

  private async tryAcquireAdvisoryLock(em: {
    query: (sql: string, params?: unknown[]) => Promise<{ got: boolean }[]>;
  }): Promise<boolean> {
    const rows = await em.query(
      'SELECT pg_try_advisory_xact_lock(1, $1) AS got',
      [DailyReminderJob.LOCK_KEY],
    );
    return rows[0]?.got === true;
  }
}
