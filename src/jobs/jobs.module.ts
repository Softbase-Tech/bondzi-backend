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
import { NotificationsProcessor } from './notifications.processor';
import { AiGenerationProcessor } from './ai-generation.processor';
import { SubscriptionRenewalJob } from './subscription-renewal.job';
import { LeaderboardJob } from './leaderboard.job';
import { LeaderboardWinnerJob } from './leaderboard-winner.job';
import { ReferralQualifyJob } from './referral-qualify.job';
import { AiBudgetAlertJob } from './ai-budget-alert.job';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import { LeaderboardModule } from '../modules/leaderboard/leaderboard.module';
import { ReferralsModule } from '../modules/referrals/referrals.module';
import { AiModule } from '../modules/ai/ai.module';
import { QUEUE_AI_GENERATION } from '../modules/ai/ai.queues';

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
    ]),
    BullModule.registerQueue({ name: QUEUE_AI_GENERATION }),
    NotificationsModule,
    LeaderboardModule,
    ReferralsModule,
    AiModule,
  ],
  providers: [
    NotificationsProcessor,
    AiGenerationProcessor,
    SubscriptionRenewalJob,
    LeaderboardJob,
    LeaderboardWinnerJob,
    ReferralQualifyJob,
    AiBudgetAlertJob,
  ],
})
export class JobsModule {}
