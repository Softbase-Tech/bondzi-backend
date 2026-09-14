import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import reportsConfig from './reports.config';
import { ReportDailySnapshot } from './entities/report-daily-snapshot.entity';
import { ReportDelivery } from './entities/report-delivery.entity';
import { GrowthCollector } from './collectors/growth.collector';
import { EngagementCollector } from './collectors/engagement.collector';
import { RevenueCollector } from './collectors/revenue.collector';
import { AiCostCollector } from './collectors/ai-cost.collector';
import { ContentCollector } from './collectors/content.collector';
import { InfraCollector } from './collectors/infra.collector';
import { SnapshotService } from './snapshot/snapshot.service';
import { DailyRenderer } from './render/daily.renderer';
import { ReportDeliveryService } from './delivery/report-delivery.service';
import { ReportJob } from './delivery/report.job';
import { SubscriptionMetricsService } from '../subscriptions/metrics/subscription-metrics.service';
import { MailService } from '../mail/mail.service';
import { RedisService } from '../../common/redis/redis.service';
import {
  QUEUE_AI_GENERATION,
  QUEUE_EMAIL,
  QUEUE_NOTIFICATIONS,
} from '../ai/ai.queues';

/**
 * Dependency-injection smoke test.
 *
 * Every other test in this module instantiates classes directly, which
 * proves the logic but not the wiring — a provider missing from
 * `reports.module.ts` would pass all of them and then fail at container
 * boot, in production, at 00:15. This compiles the real graph.
 */
describe('ReportsModule wiring', () => {
  const queue = {
    getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, failed: 0 }),
  };
  const ds = { query: jest.fn().mockResolvedValue([]), transaction: jest.fn() };

  async function build() {
    return Test.createTestingModule({
      imports: [ConfigModule.forFeature(reportsConfig)],
      providers: [
        GrowthCollector,
        EngagementCollector,
        RevenueCollector,
        AiCostCollector,
        ContentCollector,
        InfraCollector,
        SnapshotService,
        DailyRenderer,
        ReportDeliveryService,
        ReportJob,
        { provide: DataSource, useValue: ds },
        { provide: getDataSourceToken(), useValue: ds },
        { provide: getRepositoryToken(ReportDailySnapshot), useValue: {} },
        { provide: getRepositoryToken(ReportDelivery), useValue: {} },
        {
          provide: SubscriptionMetricsService,
          useValue: { mrr: jest.fn(), entitledPro: jest.fn() },
        },
        { provide: MailService, useValue: { send: jest.fn() } },
        { provide: RedisService, useValue: { raw: { info: jest.fn() } } },
        { provide: getQueueToken(QUEUE_AI_GENERATION), useValue: queue },
        { provide: getQueueToken(QUEUE_NOTIFICATIONS), useValue: queue },
        { provide: getQueueToken(QUEUE_EMAIL), useValue: queue },
      ],
    }).compile();
  }

  it('resolves every collector, service and job', async () => {
    const m = await build();
    for (const token of [
      GrowthCollector,
      EngagementCollector,
      RevenueCollector,
      AiCostCollector,
      ContentCollector,
      InfraCollector,
      SnapshotService,
      DailyRenderer,
      ReportDeliveryService,
      ReportJob,
    ]) {
      expect(m.get(token)).toBeDefined();
    }
  });

  it('registers each collector under a distinct key', async () => {
    const m = await build();
    const keys = [
      m.get(GrowthCollector).key,
      m.get(EngagementCollector).key,
      m.get(RevenueCollector).key,
      m.get(AiCostCollector).key,
      m.get(ContentCollector).key,
      m.get(InfraCollector).key,
    ];
    // The keys name the sections of the snapshot JSON; a duplicate would
    // silently overwrite one section with another.
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual([
      'ai',
      'content',
      'engagement',
      'growth',
      'infra',
      'revenue',
    ]);
  });

  describe('recipient parsing', () => {
    const load = async (env: Record<string, string>) => {
      const saved = { ...process.env };
      Object.assign(process.env, env);
      try {
        const m = await build();
        return m.get(ConfigService);
      } finally {
        process.env = saved;
      }
    };

    it('splits, trims and drops anything without an @', async () => {
      const cfg = await load({
        REPORT_RECIPIENTS_DAILY: ' a@b.co , not-an-email , c@d.co ',
      });
      expect(cfg.get('reports.recipients.daily')).toEqual(['a@b.co', 'c@d.co']);
    });

    it('treats an empty string as "nobody", not as a default', async () => {
      // This is how one cadence is switched off without touching the
      // others — it must not silently fall back to a hardcoded address.
      const cfg = await load({ REPORT_RECIPIENTS_WEEKLY: '' });
      expect(cfg.get('reports.recipients.weekly')).toEqual([]);
    });

    it('defaults REPORT_ENABLED to true but honours an explicit false', async () => {
      expect((await load({})).get('reports.enabled')).toBe(true);
      expect(
        (await load({ REPORT_ENABLED: 'false' })).get('reports.enabled'),
      ).toBe(false);
    });
  });
});
