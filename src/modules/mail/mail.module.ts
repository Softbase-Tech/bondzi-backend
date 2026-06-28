import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ObservabilityModule } from '../../common/observability/observability.module';
import { QUEUE_EMAIL } from '../ai/ai.queues';
import { User } from '../users/entities/user.entity';
import { MailService } from './mail.service';
import { EmailSend } from './entities/email-send.entity';
import { EmailAuditService } from './email-audit.service';
import { MailQueueService } from './mail-queue.service';
import { AdminAlertService } from './admin-alert.service';
import { ResendWebhookController } from './webhooks/resend-webhook.controller';
import { MailUnsubscribeController } from './mail-unsubscribe.controller';

/**
 * Transactional mail. Marked @Global so consumers don't have to add a
 * MailModule import to every feature module — once it's loaded at the
 * root, MailService is available everywhere.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([EmailSend, User]),
    BullModule.registerQueue({ name: QUEUE_EMAIL }),
    ObservabilityModule,
  ],
  controllers: [ResendWebhookController, MailUnsubscribeController],
  providers: [
    MailService,
    EmailAuditService,
    MailQueueService,
    AdminAlertService,
  ],
  exports: [
    MailService,
    MailQueueService,
    AdminAlertService,
    EmailAuditService,
  ],
})
export class MailModule {}
