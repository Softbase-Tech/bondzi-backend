import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { In, Repository } from 'typeorm';
import { Notification } from './entities/notification.entity';
import { DevicePlatform, UserDevice } from './entities/user-device.entity';
import { NotificationChannel } from '../../common/types/enums';
import { QUEUE_NOTIFICATIONS } from '../ai/ai.queues';

export interface NotificationPayload {
  userId: string;
  channel: NotificationChannel;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface RegisterPushTokenInput {
  userId: string;
  platform: DevicePlatform;
  fcmToken: string;
  deviceId?: string;
  appVersion?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notificationsRepo: Repository<Notification>,
    @InjectRepository(UserDevice)
    private readonly devicesRepo: Repository<UserDevice>,
    @InjectQueue(QUEUE_NOTIFICATIONS) private readonly queue: Queue,
  ) {}

  async listForUser(userId: string, limit = 50): Promise<Notification[]> {
    return this.notificationsRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async markRead(userId: string, notificationId: string): Promise<void> {
    await this.notificationsRepo.update(
      { id: notificationId, userId },
      { isRead: true },
    );
  }

  async send(payload: NotificationPayload): Promise<Notification> {
    const row = this.notificationsRepo.create({
      userId: payload.userId,
      channel: payload.channel,
      title: payload.title,
      body: payload.body,
      data: payload.data ?? null,
    });
    await this.notificationsRepo.save(row);

    await this.queue
      .add(
        'dispatch',
        { notificationId: row.id, channel: payload.channel },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 500,
          removeOnFail: 500,
        },
      )
      .catch((err) =>
        this.logger.warn(
          `notifications queue enqueue failed: ${(err as Error).message}`,
        ),
      );

    return row;
  }

  /**
   * Upsert an FCM token for a user. Idempotent on (user_id, fcm_token).
   * Bumps last_seen_at on existing rows so stale tokens can be pruned later.
   */
  async registerPushToken(input: RegisterPushTokenInput): Promise<void> {
    const existing = await this.devicesRepo.findOne({
      where: { userId: input.userId, fcmToken: input.fcmToken },
    });
    if (existing) {
      existing.platform = input.platform;
      existing.deviceId = input.deviceId ?? existing.deviceId;
      existing.appVersion = input.appVersion ?? existing.appVersion;
      existing.lastSeenAt = new Date();
      await this.devicesRepo.save(existing);
      return;
    }
    await this.devicesRepo.insert({
      userId: input.userId,
      platform: input.platform,
      fcmToken: input.fcmToken,
      deviceId: input.deviceId ?? null,
      appVersion: input.appVersion ?? null,
      lastSeenAt: new Date(),
    });
  }

  async tokensForUser(userId: string): Promise<string[]> {
    const rows = await this.devicesRepo.find({
      where: { userId },
      select: { fcmToken: true },
    });
    return rows.map((r) => r.fcmToken);
  }

  async pruneInvalidTokens(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    await this.devicesRepo.delete({ fcmToken: In(tokens) });
  }
}
