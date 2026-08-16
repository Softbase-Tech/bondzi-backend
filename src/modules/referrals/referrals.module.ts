import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReferralEvent } from './entities/referral-event.entity';
import { User } from '../users/entities/user.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import { XpTransaction } from '../xp-economy/entities/xp-transaction.entity';
import { XpRateConfig } from '../xp-economy/entities/xp-rate-config.entity';
import { ReferralsService } from './referrals.service';
import { ReferralsController } from './referrals.controller';
import { AdminReferralsController } from './admin-referrals.controller';
import { GamificationModule } from '../gamification/gamification.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ReferralEvent,
      User,
      ExamAnswer,
      XpTransaction,
      XpRateConfig,
    ]),
    GamificationModule,
    NotificationsModule,
  ],
  controllers: [ReferralsController, AdminReferralsController],
  providers: [ReferralsService],
  exports: [ReferralsService, TypeOrmModule],
})
export class ReferralsModule {}
