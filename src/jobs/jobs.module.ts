import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Subscription } from '../modules/subscriptions/entities/subscription.entity';
import { Notification } from '../modules/notifications/entities/notification.entity';
import { AiGenerationJob } from '../modules/admin-ai-gen/entities/ai-generation-job.entity';
import { Question } from '../modules/questions/entities/question.entity';
import { Option } from '../modules/questions/entities/option.entity';
import { Subject } from '../modules/subjects/entities/subject.entity';
import { PmTestQuestion } from '../modules/pm-test/entities/pm-test-question.entity';
import { PmTestOption } from '../modules/pm-test/entities/pm-test-option.entity';
import { SyllabusTopic } from '../modules/subjects/entities/syllabus-topic.entity';
import { PaymentEvent } from '../modules/payments/entities/payment-event.entity';
import { User } from '../modules/users/entities/user.entity';
import { ExamAnswer } from '../modules/exams/entities/exam-answer.entity';
import { XpTransaction } from '../modules/xp-economy/entities/xp-transaction.entity';
import { NotificationsProcessor } from './notifications.processor';
import { AiGenerationProcessor } from './ai-generation.processor';
import { SubscriptionRenewalJob } from './subscription-renewal.job';
import { LeaderboardJob } from './leaderboard.job';
import { LeaderboardWinnerJob } from './leaderboard-winner.job';
import { ReferralQualifyJob } from './referral-qualify.job';
import { AiBudgetAlertJob } from './ai-budget-alert.job';
import { WebhookReconciliationJob } from './webhook-reconciliation.job';
import { StreakAtRiskJob } from './streak-at-risk.job';
import { WeeklyDigestJob } from './weekly-digest.job';
import { WinnerSelectionReminderJob } from './winner-selection-reminder.job';
import { AiRejectRetentionJob } from './ai-reject-retention.job';
import { DailyReminderJob } from './daily-reminder.job';
import { WeeklyLeaderboardPushJob } from './weekly-leaderboard-push.job';
import { AccountDeletionJob } from './account-deletion.job';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import { AccountDeletionsModule } from '../modules/account-deletions/account-deletions.module';
import { LeaderboardModule } from '../modules/leaderboard/leaderboard.module';
import { ReferralsModule } from '../modules/referrals/referrals.module';
import { AiModule } from '../modules/ai/ai.module';
import { SyllabusModule } from '../modules/syllabus/syllabus.module';
import { PaymentsModule } from '../modules/payments/payments.module';
import { SubscriptionsModule } from '../modules/subscriptions/subscriptions.module';
import { EmailProcessor } from './email.processor';
import { QUEUE_AI_GENERATION, QUEUE_EMAIL } from '../modules/ai/ai.queues';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Subscription,
      Notification,
      AiGenerationJob,
      Question,
      Option,
      Subject,
      PmTestQuestion,
      PmTestOption,
      SyllabusTopic,
      PaymentEvent,
      User,
      ExamAnswer,
      XpTransaction,
    ]),
    BullModule.registerQueue({ name: QUEUE_AI_GENERATION }),
    BullModule.registerQueue({ name: QUEUE_EMAIL }),
    NotificationsModule,
    LeaderboardModule,
    ReferralsModule,
    AiModule,
    SyllabusModule,
    PaymentsModule,
    // SubscriptionRenewalJob now uses PlansService (to format
    // expiring/expired emails with the plan name + level), so the
    // subscriptions module must be imported here.
    SubscriptionsModule,
    AccountDeletionsModule,
  ],
  providers: [
    NotificationsProcessor,
    AiGenerationProcessor,
    SubscriptionRenewalJob,
    LeaderboardJob,
    LeaderboardWinnerJob,
    ReferralQualifyJob,
    AiBudgetAlertJob,
    WebhookReconciliationJob,
    StreakAtRiskJob,
    WeeklyDigestJob,
    WinnerSelectionReminderJob,
    AiRejectRetentionJob,
    DailyReminderJob,
    WeeklyLeaderboardPushJob,
    AccountDeletionJob,
    EmailProcessor,
  ],
})
export class JobsModule {}
