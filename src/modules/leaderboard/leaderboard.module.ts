import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LeaderboardEntry } from './entities/leaderboard-entry.entity';
import { Winner } from './entities/winner.entity';
import { User } from '../users/entities/user.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { LeaderboardController } from './leaderboard.controller';
import { WinnersController } from './winners.controller';
import { AdminLeaderboardController } from './admin-leaderboard.controller';
import { AdminWinnersController } from './admin-winners.controller';
import { LeaderboardService } from './leaderboard.service';
import { WinnerSelectionService } from './winner-selection.service';
import { GamificationModule } from '../gamification/gamification.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      LeaderboardEntry,
      Winner,
      User,
      ExamAnswer,
      Notification,
    ]),
    GamificationModule,
  ],
  controllers: [
    LeaderboardController,
    WinnersController,
    AdminLeaderboardController,
    AdminWinnersController,
  ],
  providers: [LeaderboardService, WinnerSelectionService],
  exports: [LeaderboardService, WinnerSelectionService, TypeOrmModule],
})
export class LeaderboardModule {}
