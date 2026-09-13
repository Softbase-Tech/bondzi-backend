import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectDataSource } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { BaseCollector, count, num } from './base.collector';
import type {
  CollectorResult,
  InfraMetrics,
  MetricCollector,
} from './collector.types';
import { RedisService } from '../../../common/redis/redis.service';
import {
  QUEUE_AI_GENERATION,
  QUEUE_EMAIL,
  QUEUE_NOTIFICATIONS,
} from '../../ai/ai.queues';

/**
 * Infrastructure — the Phase 1 subset: things this process can read
 * directly, with no external API key and no agent on the box.
 *
 * Deliberately absent, and why:
 *   - **Prometheus p95 / 5xx.** The registry is in-process and resets on
 *     every container restart, and most declared counters are never
 *     incremented (they read 0 forever). Sourcing a latency trend from it
 *     would produce numbers that look precise and are not.
 *   - **Uptime, Sentry.** Need `UPTIMEROBOT_API_KEY` / `SENTRY_API_TOKEN`.
 *     Phase 2.
 *   - **Disk, swap, cert, restarts.** Host facts, arriving via
 *     `ops_events` once the box's cron scripts write them. The table
 *     exists now and is read here; until it is populated these render as
 *     "no data" rather than failing.
 *
 * Every metric here is **point-in-time**: queue depth, Redis memory and
 * disk usage describe the moment the snapshot ran and cannot be
 * reconstructed for a past day. The snapshot service marks them
 * non-backfillable so a backfilled row dashes them instead of implying a
 * measurement that was never taken.
 */
@Injectable()
export class InfraCollector
  extends BaseCollector
  implements MetricCollector<InfraMetrics>
{
  readonly key = 'infra';

  /** Reported by the snapshot service in `_meta.non_backfillable`. */
  static readonly POINT_IN_TIME = [
    'infra.queue_depth_max',
    'infra.queue_failed',
    'infra.redis_memory_mb',
    'infra.db_size_gb',
    'engagement.streaks_active',
  ];

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly redis: RedisService,
    @InjectQueue(QUEUE_AI_GENERATION) private readonly aiQueue: Queue,
    @InjectQueue(QUEUE_NOTIFICATIONS) private readonly notifQueue: Queue,
    @InjectQueue(QUEUE_EMAIL) private readonly emailQueue: Queue,
  ) {
    super();
  }

  // Infra metrics are point-in-time, so the range is genuinely unused:
  // there is no historical queue depth to ask for.
  async collect(): Promise<CollectorResult<InfraMetrics>> {
    return this.run<InfraMetrics>(async (errors) => {
      const dbSize = await this.guard(
        'infra.db_size',
        errors,
        () =>
          this.ds.query<Array<{ bytes: string }>>(
            `SELECT pg_database_size(current_database()) AS bytes`,
          ),
        [],
      );

      // `INFO memory` returns a text blob; used_memory is bytes.
      const redisMb = await this.guard(
        'infra.redis_memory',
        errors,
        async () => {
          const info = await this.redis.raw.info('memory');
          const m = /used_memory:(\d+)/.exec(info);
          return m
            ? Math.round((parseInt(m[1], 10) / 1_048_576) * 10) / 10
            : null;
        },
        null,
      );

      // Only the three queues that actually exist. QUEUE_LEADERBOARD and
      // QUEUE_SUBSCRIPTIONS are dead constants with no producer or
      // consumer — reporting them would print a permanent, meaningless 0.
      const queues: InfraMetrics['queues'] = {};
      let failed = 0;
      let depth = 0;
      let queuesRead = false;
      for (const [name, q] of [
        [QUEUE_AI_GENERATION, this.aiQueue],
        [QUEUE_NOTIFICATIONS, this.notifQueue],
        [QUEUE_EMAIL, this.emailQueue],
      ] as const) {
        const counts = await this.guard(
          `infra.queue.${name}`,
          errors,
          () => q.getJobCounts('waiting', 'failed'),
          null,
        );
        if (!counts) continue;
        queuesRead = true;
        const w = counts.waiting ?? 0;
        const f = counts.failed ?? 0;
        queues[name] = { waiting: w, failed: f };
        failed += f;
        depth = Math.max(depth, w);
      }

      // Host facts from ops_events (Phase 2 populates these). Newest row
      // per type; absent means "not instrumented yet", which is null and
      // not false — reporting `backup_ok: false` for a backup that simply
      // was not measured would be a fabricated alert.
      const ops = await this.guard(
        'infra.ops_events',
        errors,
        () =>
          this.ds.query<Array<{ event_type: string; payload: unknown }>>(
            `SELECT DISTINCT ON (event_type) event_type, payload
               FROM ops_events
              WHERE occurred_at > now() - interval '36 hours'
              ORDER BY event_type, occurred_at DESC`,
          ),
        [],
      );
      const backup = ops.find((o) => o.event_type === 'backup')?.payload as
        | { ok?: boolean; bytes?: number }
        | undefined;
      const host = ops.find((o) => o.event_type === 'host_stats')?.payload as
        | { disk_used_pct?: number }
        | undefined;

      return {
        db_size_gb: dbSize[0]
          ? Math.round((count(dbSize[0].bytes) / 1_073_741_824) * 100) / 100
          : null,
        redis_memory_mb: redisMb,
        queue_failed: queuesRead ? failed : null,
        queue_depth_max: queuesRead ? depth : null,
        queues,
        backup_ok: backup?.ok ?? null,
        backup_bytes: backup?.bytes !== undefined ? num(backup.bytes) : null,
        disk_used_pct:
          host?.disk_used_pct !== undefined ? num(host.disk_used_pct) : null,
      };
    });
  }
}
