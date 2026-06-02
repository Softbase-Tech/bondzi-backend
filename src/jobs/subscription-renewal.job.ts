import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, LessThanOrEqual, Repository } from 'typeorm';
import { Subscription } from '../modules/subscriptions/entities/subscription.entity';
import { NotificationsService } from '../modules/notifications/notifications.service';
import {
  BillingInterval,
  NotificationChannel,
  SubscriptionStatus,
} from '../common/types/enums';
import { User } from '../modules/users/entities/user.entity';
import { PlansService } from '../modules/subscriptions/plans/plans.service';
import { MailService } from '../modules/mail/mail.service';
import { MailEvent } from '../modules/mail/mail.types';

const CADENCE_LABEL: Record<BillingInterval, string> = {
  [BillingInterval.MONTHLY]: 'monthly',
  [BillingInterval.SIX_MONTH]: '6-month',
  [BillingInterval.ANNUAL]: 'annual',
};

/**
 * Cron: hourly scan for subscriptions expiring within 72h and flip-to-expired
 * for those already past their expires_at.
 *
 * Hardening since the audit:
 *   1. Postgres advisory lock so two worker replicas (deploy overlap) can't
 *      both fire the same "expired" notification. Whoever holds the lock
 *      this minute does the work; the other just returns.
 *   2. ACTIVE + TRIAL + XP_CREDITED all expire. The previous shape only
 *      handled ACTIVE — XP_CREDITED rows whose expires_at passed sat in
 *      xp_credited forever, breaking audit/cleanup and never sending the
 *      "your XP credit ran out" nudge.
 */
@Injectable()
export class SubscriptionRenewalJob {
  private readonly logger = new Logger(SubscriptionRenewalJob.name);
  /** Stable lock key — same value across replicas, different per cron. */
  private static readonly LOCK_KEY = 17_001;

  constructor(
    @InjectRepository(Subscription)
    private readonly subsRepo: Repository<Subscription>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
    private readonly plans: PlansService,
    private readonly mail: MailService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async tick(): Promise<void> {
    if (process.env.WORKER_MODE !== 'true') return;
    await this.dataSource.transaction(async (em) => {
      const got = await this.tryAcquireAdvisoryLock(em);
      if (!got) {
        this.logger.log(
          '[subs] another worker holds the renewal lock; skipping this tick',
        );
        return;
      }
      await this.scan();
    });
  }

  private async scan(): Promise<void> {
    const now = new Date();
    const in72h = new Date(now.getTime() + 72 * 3600 * 1000);

    // Expire ACTIVE + TRIAL + XP_CREDITED rows that have passed their
    // expires_at, then collect the ones still in the 72h reminder
    // window. We use `In` on status so an `xp_credited` sub that lapsed
    // also gets cleaned up and the user gets the nudge.
    const candidates = await this.subsRepo.find({
      where: {
        status: In([
          SubscriptionStatus.ACTIVE,
          SubscriptionStatus.TRIAL,
          SubscriptionStatus.XP_CREDITED,
        ]),
        expiresAt: LessThanOrEqual(in72h),
      },
      take: 500,
    });

    for (const sub of candidates) {
      if (!sub.expiresAt) continue;
      if (sub.expiresAt.getTime() <= now.getTime()) {
        sub.status = SubscriptionStatus.EXPIRED;
        await this.subsRepo.save(sub);
        this.logger.log(`[subs] expired sub=${sub.id} status=${sub.status}`);
        await this.notifications
          .send({
            userId: sub.userId,
            channel: NotificationChannel.IN_APP,
            title: 'Your Bondzi plan has expired',
            body: 'Renew to keep access to premium explanations and practice packs.',
            data: { type: 'subscription_expired', subscriptionId: sub.id },
          })
          .catch(() => void 0);
        await this.dispatchExpiredEmail(sub).catch(() => void 0);
      } else if (sub.expiresAt.getTime() - now.getTime() < 72 * 3600 * 1000) {
        const cadence = sub.billingInterval
          ? CADENCE_LABEL[sub.billingInterval]
          : sub.status === SubscriptionStatus.XP_CREDITED
            ? 'XP-credit'
            : 'current';
        await this.notifications
          .send({
            userId: sub.userId,
            channel: NotificationChannel.IN_APP,
            title: 'Your plan expires soon',
            body: `Your ${cadence} plan expires on ${sub.expiresAt.toISOString().slice(0, 10)}.`,
            data: { type: 'subscription_expiring', subscriptionId: sub.id },
          })
          .catch(() => void 0);
        await this.dispatchExpiringSoonEmail(sub, now).catch(() => void 0);
      }
    }
  }

  private async dispatchExpiringSoonEmail(
    sub: Subscription,
    now: Date,
  ): Promise<void> {
    if (!sub.planId || !sub.expiresAt) return;
    const [user, plan] = await Promise.all([
      this.usersRepo.findOne({ where: { id: sub.userId } }),
      this.plans.getById(sub.planId).catch(() => null),
    ]);
    if (!user?.email || !plan) return;
    const msRemaining = sub.expiresAt.getTime() - now.getTime();
    // Round up so "expires in 2 hours" still reads as "1 day" rather
    // than "0 days" in the subject line.
    const daysRemaining = Math.max(
      1,
      Math.ceil(msRemaining / (24 * 3600 * 1000)),
    );
    await this.mail.send(MailEvent.SUBSCRIPTION_EXPIRING_SOON, user.email, {
      recipientName: user.fullName ?? undefined,
      planName: plan.name,
      level: plan.level.toUpperCase(),
      expiresAt: sub.expiresAt,
      daysRemaining,
    });
  }

  private async dispatchExpiredEmail(sub: Subscription): Promise<void> {
    if (!sub.planId || !sub.expiresAt) return;
    const [user, plan] = await Promise.all([
      this.usersRepo.findOne({ where: { id: sub.userId } }),
      this.plans.getById(sub.planId).catch(() => null),
    ]);
    if (!user?.email || !plan) return;
    await this.mail.send(MailEvent.SUBSCRIPTION_EXPIRED, user.email, {
      recipientName: user.fullName ?? undefined,
      planName: plan.name,
      level: plan.level.toUpperCase(),
      expiredAt: sub.expiresAt,
    });
  }

  /**
   * `pg_try_advisory_xact_lock` returns true if it acquired the lock,
   * false otherwise. The lock is released at the end of the transaction
   * — perfect for "this cron tick already running in another replica?".
   * A two-int variant gives us a namespace + key; we use a fixed
   * (namespace, key) tuple per cron so different crons don't collide.
   */
  private async tryAcquireAdvisoryLock(em: {
    query: (sql: string, params?: unknown[]) => Promise<{ got: boolean }[]>;
  }): Promise<boolean> {
    const rows = await em.query(
      'SELECT pg_try_advisory_xact_lock(1, $1) AS got',
      [SubscriptionRenewalJob.LOCK_KEY],
    );
    return rows[0]?.got === true;
  }
}
