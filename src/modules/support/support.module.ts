import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SupportTicket } from './entities/support-ticket.entity';
import { SupportTicketMessage } from './entities/support-ticket-message.entity';
import { User } from '../users/entities/user.entity';
import { SupportTicketsService } from './support-tickets.service';
import { SupportNotifierService } from './support-notifier.service';
import { SupportController } from './support.controller';
import { SupportAdminController } from './support-admin.controller';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * Support ticket subsystem.
 *
 * Consumes MailModule (AdminAlertService — ops inbox for new tickets +
 * user replies) and NotificationsModule (in-app row + push dispatch on
 * admin reply and ticket close). The user-side controller mounts on
 * `/support/tickets`; the admin-side on `/admin/support/tickets` and
 * is role-gated to admin/superadmin.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([SupportTicket, SupportTicketMessage, User]),
    MailModule,
    NotificationsModule,
  ],
  controllers: [SupportController, SupportAdminController],
  providers: [SupportTicketsService, SupportNotifierService],
  exports: [SupportTicketsService],
})
export class SupportModule {}
