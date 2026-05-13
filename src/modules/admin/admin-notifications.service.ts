import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  NotificationChannel,
  SubscriptionStatus,
} from '../../common/types/enums';
import {
  BroadcastNotificationDto,
  BroadcastSegment,
} from './dto/broadcast-notification.dto';

export interface BroadcastResult {
  queued: number;
  channels: NotificationChannel[];
  segment: BroadcastSegment;
}

/**
 * Resolves a broadcast segment to a set of user_ids, then fans out a
 * notification per (user, channel). Each Notification row hits the BullMQ
 * queue and is dispatched by NotificationsProcessor.
 *
 * Segments:
 *   all            every is_active user
 *   free           users with no active paid subscription
 *   paid           users whose most recent subscription is active and not 'free'
 *   expiring_soon  users whose active subscription expires within 7 days
 *   custom         filter by region and/or schoolId (reserved for future use)
 */
@Injectable()
export class AdminNotificationsService {
  private readonly logger = new Logger(AdminNotificationsService.name);

  constructor(
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    @InjectRepository(Subscription)
    private readonly subsRepo: Repository<Subscription>,
    private readonly notifications: NotificationsService,
  ) {}

  async broadcast(dto: BroadcastNotificationDto): Promise<BroadcastResult> {
    const userIds = await this.resolveSegment(dto);
    let queued = 0;
    for (const userId of userIds) {
      for (const channel of dto.channels) {
        await this.notifications
          .send({
            userId,
            channel,
            title: dto.title,
            body: dto.body,
            data: { type: 'broadcast', segment: dto.segment },
          })
          .then(() => {
            queued++;
          })
          .catch((err) =>
            this.logger.warn(
              `broadcast send failed user=${userId}: ${(err as Error).message}`,
            ),
          );
      }
    }
    this.logger.log(
      `[broadcast] segment=${dto.segment} channels=${dto.channels.join(',')} recipients=${userIds.length} queued=${queued}`,
    );
    return { queued, channels: dto.channels, segment: dto.segment };
  }

  private async resolveSegment(
    dto: BroadcastNotificationDto,
  ): Promise<string[]> {
    switch (dto.segment) {
      case BroadcastSegment.ALL:
        return this.activeUserIds(dto);
      case BroadcastSegment.FREE:
        return this.freeUserIds(dto);
      case BroadcastSegment.PAID:
        return this.paidUserIds(dto);
      case BroadcastSegment.EXPIRING_SOON:
        return this.expiringSoonUserIds(dto);
      case BroadcastSegment.CUSTOM:
        return this.activeUserIds(dto);
    }
  }

  private async activeUserIds(dto: BroadcastNotificationDto): Promise<string[]> {
    const qb = this.usersRepo
      .createQueryBuilder('u')
      .select('u.id', 'id')
      .where('u.is_active = true')
      .andWhere('u.deleted_at IS NULL');
    if (dto.region) qb.andWhere('u.region = :region', { region: dto.region });
    const rows = await qb.getRawMany<{ id: string }>();
    return rows.map((r) => r.id);
  }

  private async paidUserIds(dto: BroadcastNotificationDto): Promise<string[]> {
    const qb = this.subsRepo
      .createQueryBuilder('s')
      .innerJoin('s.user', 'u', 'u.is_active = true AND u.deleted_at IS NULL')
      .select('DISTINCT s.user_id', 'id')
      .where('s.status IN (:...statuses)', {
        statuses: [
          SubscriptionStatus.ACTIVE,
          SubscriptionStatus.XP_CREDITED,
          SubscriptionStatus.TRIAL,
        ],
      })
      .andWhere('(s.expires_at IS NULL OR s.expires_at > NOW())');
    if (dto.region) qb.andWhere('u.region = :region', { region: dto.region });
    const rows = await qb.getRawMany<{ id: string }>();
    return rows.map((r) => r.id);
  }

  private async freeUserIds(dto: BroadcastNotificationDto): Promise<string[]> {
    const paid = new Set(await this.paidUserIds(dto));
    const all = await this.activeUserIds(dto);
    return all.filter((id) => !paid.has(id));
  }

  private async expiringSoonUserIds(
    dto: BroadcastNotificationDto,
  ): Promise<string[]> {
    const qb = this.subsRepo
      .createQueryBuilder('s')
      .innerJoin('s.user', 'u', 'u.is_active = true AND u.deleted_at IS NULL')
      .select('DISTINCT s.user_id', 'id')
      .where('s.status = :status', { status: SubscriptionStatus.ACTIVE })
      .andWhere("s.expires_at BETWEEN NOW() AND NOW() + INTERVAL '7 days'");
    if (dto.region) qb.andWhere('u.region = :region', { region: dto.region });
    const rows = await qb.getRawMany<{ id: string }>();
    return rows.map((r) => r.id);
  }
}
