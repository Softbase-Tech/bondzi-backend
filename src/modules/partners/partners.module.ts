import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { DeviceSession } from '../auth/entities/device-session.entity';
import { Exam } from '../exams/entities/exam.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import { MailModule } from '../mail/mail.module';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { SubscriptionPlanEntity } from '../subscriptions/plans/entities/subscription-plan.entity';
import { User } from '../users/entities/user.entity';
import { PartnerAppeal } from './entities/partner-appeal.entity';
import { PartnerAttribution } from './entities/partner-attribution.entity';
import { PartnerBanner } from './entities/partner-banner.entity';
import { PartnerCommission } from './entities/partner-commission.entity';
import { PartnerFraudEvent } from './entities/partner-fraud-event.entity';
import { PartnerPayout } from './entities/partner-payout.entity';
import { PartnerReferralCode } from './entities/partner-referral-code.entity';
import { PartnerSignupCredit } from './entities/partner-signup-credit.entity';
import { PartnerTermsVersion } from './entities/partner-terms-version.entity';
import { Partner } from './entities/partner.entity';
import { PartnerAppealsService } from './partner-appeals.service';
import { PartnerAttributionsService } from './partner-attributions.service';
import { PartnerAuthGuard } from './partner-auth.guard';
import { PartnerBannersService } from './partner-banners.service';
import { PartnerCommissionsService } from './partner-commissions.service';
import { PartnerPayoutsService } from './partner-payouts.service';
import { PartnerTermsService } from './partner-terms.service';
import { PartnersAdminController } from './partners-admin.controller';
import { PartnersAdminService } from './partners-admin.service';
import { PartnersController } from './partners.controller';
import { PartnersService } from './partners.service';

/**
 * Foundation + commission + payout module for the partner portal.
 * Exposes:
 *
 *   - PartnersService              (partner + code lifecycle)
 *   - PartnerAttributionsService   (register-time attribution + fraud)
 *   - PartnerCommissionsService    (Streams A/B/C + Plus refund clawback)
 *   - PartnerPayoutsService        (weekly payout lifecycle + invoice PDF)
 *   - PartnersAdminService         (admin approvals + ledger reads)
 *   - PartnerTermsService          (versioned commission-terms doc)
 *   - PartnerAuthGuard             (route protection)
 *
 * Consumed by AuthModule (register hook → attribution) via
 * `forwardRef` because AuthModule also imports parts of this
 * subgraph. Commissions are triggered from SubscriptionsService
 * (Plus activation, refund clawback) and ExamsService (post-completion
 * ticks). Admin surfaces (approve, list commissions, mark payouts
 * paid) mount on /admin/partners/*. Terms editing, fraud queue, and
 * appeals are Phase 5.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Partner,
      PartnerReferralCode,
      PartnerAttribution,
      PartnerTermsVersion,
      PartnerSignupCredit,
      PartnerCommission,
      PartnerPayout,
      PartnerFraudEvent,
      PartnerAppeal,
      PartnerBanner,
      DeviceSession,
      User,
      // Read-only cross-module reads from the commissions engine:
      // Subscription + SubscriptionPlanEntity (Stream A gating +
      // active-Plus lookup in Stream C), Exam + ExamAnswer (answer
      // counts for Streams B and C). Owned by their home modules —
      // TypeORM allows the same entity to be registered on multiple
      // module scopes.
      Subscription,
      SubscriptionPlanEntity,
      Exam,
      ExamAnswer,
    ]),
    forwardRef(() => AuthModule),
    MailModule,
  ],
  controllers: [PartnersController, PartnersAdminController],
  providers: [
    PartnersService,
    PartnerAttributionsService,
    PartnerCommissionsService,
    PartnerPayoutsService,
    PartnersAdminService,
    PartnerAppealsService,
    PartnerBannersService,
    PartnerTermsService,
    PartnerAuthGuard,
  ],
  exports: [
    PartnersService,
    PartnerAttributionsService,
    PartnerCommissionsService,
    PartnerPayoutsService,
    PartnersAdminService,
    PartnerAppealsService,
    PartnerBannersService,
    PartnerTermsService,
    PartnerAuthGuard,
    TypeOrmModule,
  ],
})
export class PartnersModule {}
