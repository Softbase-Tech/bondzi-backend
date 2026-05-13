import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { Subscription } from '../modules/subscriptions/entities/subscription.entity';
import { NotificationsService } from '../modules/notifications/notifications.service';
import {
  BillingInterval,
  NotificationChannel,
  SubscriptionStatus,
} from '../common/types/enums';

const CADENCE_LABEL: Record<BillingInterval, string> = {
  [BillingInterval.MONTHLY]: 'monthly',
  [BillingInterval.SIX_MONTH]: '6-month',
  [BillingInterval.ANNUAL]: 'annual',
};

/**
 * Cron: hourly scan for subscriptions expiring within 72h and flip-to-expired
 * for those already past their expires_at.
 */
@Injectable()
export class SubscriptionRenewalJob {
  private readonly logger = new Logger(SubscriptionRenewalJob.name);

  constructor(
    @InjectRepository(Subscription)
    private readonly subsRepo: Repository<Subscription>,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async tick(): Promise<void> {
    // Worker-only — see ai-budget-alert.job.ts for the explanation.
    if (process.env.WORKER_MODE !== 'true') return;
    const now = new Date();
    const in72h = new Date(now.getTime() + 72 * 3600 * 1000);

    const expiringSoon = await this.subsRepo.find({
      where: [
        {
          status: SubscriptionStatus.ACTIVE,
          expiresAt: LessThanOrEqual(in72h),
        },
      ],
      take: 500,
    });

    for (const sub of expiringSoon) {
      if (!sub.expiresAt) continue;
      if (sub.expiresAt.getTime() <= now.getTime()) {
        sub.status = SubscriptionStatus.EXPIRED;
        await this.subsRepo.save(sub);
        this.logger.log(`[subs] expired sub=${sub.id}`);
        await this.notifications
          .send({
            userId: sub.userId,
            channel: NotificationChannel.IN_APP,
            title: 'Your PassMaster plan has expired',
            body: 'Renew to keep access to premium explanations and practice packs.',
            data: { type: 'subscription_expired', subscriptionId: sub.id },
          })
          .catch(() => void 0);
      } else if (sub.expiresAt.getTime() - now.getTime() < 72 * 3600 * 1000) {
        const cadence = sub.billingInterval
          ? CADENCE_LABEL[sub.billingInterval]
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
      }
    }
  }
}
