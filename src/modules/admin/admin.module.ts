import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { Exam } from '../exams/entities/exam.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import { AiUsageLog } from '../ai/entities/ai-usage-log.entity';
import { QuestionFlag } from '../questions/entities/question-flag.entity';
import { Question } from '../questions/entities/question.entity';
import { PmTestQuestion } from '../pm-test/entities/pm-test-question.entity';
import { AuditLog } from './entities/audit-log.entity';
import { XpTransaction } from '../xp-economy/entities/xp-transaction.entity';
import { XpRedemption } from '../xp-economy/entities/xp-redemption.entity';
import { ReferralEvent } from '../referrals/entities/referral-event.entity';
import { Winner } from '../leaderboard/entities/winner.entity';
import { AdminService } from './admin.service';
import { AdminJobsService } from './admin-jobs.service';
import { AdminNotificationsService } from './admin-notifications.service';
import { AdminController } from './admin.controller';
import { PaymentsModule } from '../payments/payments.module';
import { NotificationsModule } from '../notifications/notifications.module';
import {
  QUEUE_AI_GENERATION,
  QUEUE_NOTIFICATIONS,
} from '../ai/ai.queues';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Subscription,
      Exam,
      ExamAnswer,
      AiUsageLog,
      QuestionFlag,
      Question,
      PmTestQuestion,
      AuditLog,
      XpTransaction,
      XpRedemption,
      ReferralEvent,
      Winner,
    ]),
    BullModule.registerQueue(
      { name: QUEUE_AI_GENERATION },
      { name: QUEUE_NOTIFICATIONS },
    ),
    PaymentsModule,
    NotificationsModule,
  ],
  controllers: [AdminController],
  providers: [AdminService, AdminJobsService, AdminNotificationsService],
  exports: [AdminService],
})
export class AdminModule {}
