import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReportDailySnapshot } from './entities/report-daily-snapshot.entity';
import { ReportDelivery } from './entities/report-delivery.entity';
import { GrowthCollector } from './collectors/growth.collector';
import { EngagementCollector } from './collectors/engagement.collector';
import { RevenueCollector } from './collectors/revenue.collector';
import { AiCostCollector } from './collectors/ai-cost.collector';
import { ContentCollector } from './collectors/content.collector';
import { InfraCollector } from './collectors/infra.collector';
import { SnapshotService } from './snapshot/snapshot.service';
import { SnapshotJob } from './snapshot/snapshot.job';
import { DailyRenderer } from './render/daily.renderer';
import { ReportDeliveryService } from './delivery/report-delivery.service';
import { ReportJob } from './delivery/report.job';
import { ReportsController } from './reports.controller';
import { MetricsAggregatorService } from './aggregate/metrics-aggregator.service';
import { MailModule } from '../mail/mail.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import {
  QUEUE_AI_GENERATION,
  QUEUE_EMAIL,
  QUEUE_NOTIFICATIONS,
} from '../ai/ai.queues';

/**
 * Automated reporting.
 *
 * Owns no domain data: every metric is read from tables other modules
 * write. The one thing it persists is the daily snapshot, which is the
 * only durable record of what the numbers were once raw data is pruned.
 *
 * Queues are registered here only to *read* `getJobCounts()` for the infra
 * section. The three named are the ones that actually exist —
 * `QUEUE_LEADERBOARD` and `QUEUE_SUBSCRIPTIONS` are dead constants with no
 * producer or consumer, and reporting them would print a permanent 0 that
 * looks like a healthy empty queue rather than a queue nobody uses.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ReportDailySnapshot, ReportDelivery]),
    BullModule.registerQueue(
      { name: QUEUE_AI_GENERATION },
      { name: QUEUE_NOTIFICATIONS },
      { name: QUEUE_EMAIL },
    ),
    MailModule,
    SubscriptionsModule,
  ],
  controllers: [ReportsController],
  providers: [
    GrowthCollector,
    EngagementCollector,
    RevenueCollector,
    AiCostCollector,
    ContentCollector,
    InfraCollector,
    SnapshotService,
    SnapshotJob,
    DailyRenderer,
    ReportDeliveryService,
    ReportJob,
    MetricsAggregatorService,
  ],
  exports: [SnapshotService, ReportJob, MetricsAggregatorService],
})
export class ReportsModule {}
