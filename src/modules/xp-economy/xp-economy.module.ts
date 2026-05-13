import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { XpRateConfig } from './entities/xp-rate-config.entity';
import { XpRedemptionConfig } from './entities/xp-redemption-config.entity';
import { XpTransaction } from './entities/xp-transaction.entity';
import { XpRedemption } from './entities/xp-redemption.entity';
import { User } from '../users/entities/user.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { XpEconomyService } from './xp-economy.service';
import { XpEconomyController } from './xp-economy.controller';
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
    ]),
    forwardRef(() => GamificationModule),
  ],
  controllers: [XpEconomyController],
  providers: [XpEconomyService],
  exports: [XpEconomyService, TypeOrmModule],
})
export class XpEconomyModule {}
