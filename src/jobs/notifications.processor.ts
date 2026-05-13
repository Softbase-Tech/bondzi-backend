import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { Notification } from '../modules/notifications/entities/notification.entity';
import { NotificationChannel } from '../common/types/enums';
import { QUEUE_NOTIFICATIONS } from '../modules/ai/ai.queues';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { FirebaseAdminService } from '../modules/notifications/firebase-admin.service';

interface DispatchPayload {
  notificationId: string;
  channel: NotificationChannel;
}

function stringifyData(
  data: Record<string, unknown> | null,
): Record<string, string> {
  if (!data) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}

/**
 * Fan-out notification dispatcher. IN_APP writes are already persisted by
 * NotificationsService.send(); this worker handles external delivery for
 * PUSH/SMS/WHATSAPP channels. Each row's sent_at is stamped when the worker
 * has *attempted* delivery (not when the user actually opens the notif).
 */
@Injectable()
@Processor(QUEUE_NOTIFICATIONS, { concurrency: 5 })
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notificationsRepo: Repository<Notification>,
    private readonly notifications: NotificationsService,
    private readonly firebase: FirebaseAdminService,
  ) {
    super();
  }

  async process(job: Job<DispatchPayload>): Promise<{ ok: boolean }> {
    const row = await this.notificationsRepo.findOne({
      where: { id: job.data.notificationId },
    });
    if (!row) return { ok: true };

    switch (job.data.channel) {
      case NotificationChannel.IN_APP:
        // No external send; the row already exists for the inbox.
        break;
      case NotificationChannel.PUSH:
        await this.sendPush(row);
        break;
      case NotificationChannel.SMS:
        this.logger.log(
          `[notify] sms → ${row.userId} "${row.title}" (SMS provider not yet wired)`,
        );
        break;
      case NotificationChannel.WHATSAPP:
        this.logger.log(`[notify] whatsapp → ${row.userId} (P2)`);
        break;
    }

    row.sentAt = new Date();
    await this.notificationsRepo.save(row);
    return { ok: true };
  }

  private async sendPush(row: Notification): Promise<void> {
    if (!this.firebase.configured) {
      this.logger.warn(
        `[notify] push → ${row.userId} "${row.title}" (Firebase not configured; skipping)`,
      );
      return;
    }
    const tokens = await this.notifications.tokensForUser(row.userId);
    if (tokens.length === 0) {
      this.logger.log(
        `[notify] push → ${row.userId} no FCM tokens registered; skipping`,
      );
      return;
    }
    const { successCount, invalidTokens } = await this.firebase.sendToTokens(
      tokens,
      {
        title: row.title,
        body: row.body,
        data: {
          notificationId: row.id,
          ...stringifyData(row.data),
        },
      },
    );
    if (invalidTokens.length > 0) {
      await this.notifications.pruneInvalidTokens(invalidTokens);
    }
    this.logger.log(
      `[notify] push → ${row.userId} delivered=${successCount}/${tokens.length} pruned=${invalidTokens.length}`,
    );
  }
}
