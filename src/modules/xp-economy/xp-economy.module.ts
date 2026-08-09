import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { XpRateConfig } from './entities/xp-rate-config.entity';
import { XpRedemptionConfig } from './entities/xp-redemption-config.entity';
import { XpTransaction } from './entities/xp-transaction.entity';
import { XpRedemption } from './entities/xp-redemption.entity';
import { User } from '../users/entities/user.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { SubscriptionPlanEntity } from '../subscriptions/plans/entities/subscription-plan.entity';
import { ReferralEvent } from '../referrals/entities/referral-event.entity';
import { XpEconomyService } from './xp-economy.service';
import { XpEconomyController } from './xp-economy.controller';
import { AdminXpEconomyController } from './admin-xp-economy.controller';
import { GamificationModule } from '../gamification/gamification.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      XpRateConfig,
      XpRedemptionConfig,
      XpTransaction,
      XpRedemption,
      User,
      Subscription,
      // SubscriptionPlanEntity registered here so `XpEconomyService.redeem`
      // can resolve the default Pro plan for the user's current level
      // and anchor the XP_CREDITED row to that slot. Without the anchor
      // the per-level entitlement query would never surface XP-credit
      // grants.
      SubscriptionPlanEntity,
      // ReferralEvent registered here so the admin XP-economy controller
      // can query the referral summary directly. Plain query injection;
      // no need to bring in ReferralsModule (which would introduce a
      // back-and-forth dependency).
      ReferralEvent,
    ]),
    forwardRef(() => GamificationModule),
  ],
  controllers: [XpEconomyController, AdminXpEconomyController],
  providers: [XpEconomyService],
  exports: [XpEconomyService, TypeOrmModule],
})
export class XpEconomyModule {}
