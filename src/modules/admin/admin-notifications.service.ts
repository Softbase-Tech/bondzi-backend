import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  NotificationChannel,
  SubscriptionStatus,
} from '../../common/types/enums';
import {
  BroadcastNotificationDto,
  BroadcastSegment,
} from './dto/broadcast-notification.dto';
import { SendUserPushDto } from './dto/send-user-push.dto';

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
    @InjectRepository(Notification)
    private readonly notificationsRepo: Repository<Notification>,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Admin: send a push to ONE user. Records the actor so the
   * notification log on /admin/notifications can show "sent by
   * admin X". Returns the created Notification row so the admin
   * UI can confirm what was sent.
   */
  async sendToUser(
    adminId: string,
    targetUserId: string,
    dto: SendUserPushDto,
  ): Promise<Notification> {
    const user = await this.usersRepo.findOne({
      where: { id: targetUserId },
      select: ['id', 'isActive'],
    });
    if (!user) throw new NotFoundException('Target user not found');
    if (!user.isActive) {
      throw new NotFoundException(
        'Target user is inactive — cannot send push.',
      );
    }
    const row = await this.notifications.send({
      userId: targetUserId,
      channel: NotificationChannel.PUSH,
      title: dto.title,
      body: dto.body,
      data: {
        type: 'admin_message',
        // Stamping actorId here makes the audit log straightforward:
        // the /admin/notifications viewer surfaces this column on
        // every row so ops can see who sent what.
        sentByAdminId: adminId,
        ...(dto.deepLink ? { deepLink: dto.deepLink } : {}),
      },
    });
    this.logger.log(
      `[admin-push] admin=${adminId} → user=${targetUserId} notification=${row.id}`,
    );
    return row;
  }

  /**
   * Paginated read of the notifications table — fuels the admin log
   * viewer. Channel + type filters let ops drill into "all pushes
   * sent today" or "every account_credited row this month".
   */
  async listAll(opts: {
    limit?: number;
    offset?: number;
    userId?: string;
    channel?: NotificationChannel;
    type?: string;
  }): Promise<{ items: Notification[]; total: number }> {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const offset = Math.max(0, opts.offset ?? 0);
    const qb = this.notificationsRepo
      .createQueryBuilder('n')
      .leftJoinAndSelect('n.user', 'user')
      .orderBy('n.created_at', 'DESC')
      .take(limit)
      .skip(offset);
    if (opts.userId) qb.andWhere('n.user_id = :uid', { uid: opts.userId });
    if (opts.channel) qb.andWhere('n.channel = :ch', { ch: opts.channel });
    if (opts.type) {
      // The notification `type` lives inside the JSONB `data` column
      // — keyed on `type`. We surface this as a top-level filter so
      // the admin doesn't need to know the column shape.
      qb.andWhere(`n.data->>'type' = :t`, { t: opts.type });
    }
    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }

  /**
   * Retention: delete notification rows older than `olderThanDays`
   * (default 90). Returns the affected row count for logging.
   * Daily cron in NotificationRetentionJob fires this.
   */
  async pruneOlderThan(olderThanDays = 90): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const result = await this.notificationsRepo
      .createQueryBuilder()
      .delete()
      .from(Notification)
      .where('created_at < :cutoff', { cutoff })
      .execute();
    const affected = result.affected ?? 0;
    if (affected > 0) {
      this.logger.log(
        `[notifications] pruned ${affected} rows older than ${olderThanDays}d (cutoff=${cutoff.toISOString()})`,
      );
    }
    return affected;
  }

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

  private async activeUserIds(
    dto: BroadcastNotificationDto,
  ): Promise<string[]> {
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
