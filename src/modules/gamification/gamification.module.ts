import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { XpRateConfig } from '../xp-economy/entities/xp-rate-config.entity';
import { XpTransaction } from '../xp-economy/entities/xp-transaction.entity';
import { GamificationService } from './gamification.service';
import { StreakService } from './streak.service';
import { XpEconomyModule } from '../xp-economy/xp-economy.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, XpRateConfig, XpTransaction]),
    forwardRef(() => XpEconomyModule),
    NotificationsModule,
  ],
  providers: [GamificationService, StreakService],
  exports: [GamificationService, StreakService],
})
export class GamificationModule {}
