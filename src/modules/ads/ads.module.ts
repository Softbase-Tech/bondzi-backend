import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdConfig } from './entities/ad-config.entity';
import { AdsController } from './ads.controller';
import { AdsService } from './ads.service';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { GamificationModule } from '../gamification/gamification.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AdConfig]),
    SubscriptionsModule,
    GamificationModule,
  ],
  controllers: [AdsController],
  providers: [AdsService],
  exports: [AdsService, TypeOrmModule],
})
export class AdsModule {}
