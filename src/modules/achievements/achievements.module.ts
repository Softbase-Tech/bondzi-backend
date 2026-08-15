import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Achievement } from './entities/achievement.entity';
import { UserAchievement } from './entities/user-achievement.entity';
import { AchievementsService } from './achievements.service';
import { AchievementsController } from './achievements.controller';
import { AchievementsAdminController } from './achievements-admin.controller';
import { UsersModule } from '../users/users.module';

/**
 * Achievements subsystem — the milestones catalogue that powers the
 * mobile Profile strip. Depends on UsersModule because the service
 * reads `getStats(userId)` to evaluate unlocks in a single read call.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Achievement, UserAchievement]),
    UsersModule,
  ],
  controllers: [AchievementsController, AchievementsAdminController],
  providers: [AchievementsService],
  exports: [AchievementsService],
})
export class AchievementsModule {}
