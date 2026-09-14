import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { LockKey } from '../../../jobs/advisory-lock-keys';
import { SnapshotService } from './snapshot.service';
import { snapshotDateFor } from '../date-range.util';

/**
 * Cron: compute yesterday's metric snapshot.
 *
 * 00:15 rather than 00:00 so midnight-boundary writes have settled — a
 * payment webhook or an exam completion landing at 23:59:59 should be in
 * the day it belongs to, not racing the aggregate that counts it.
 */
@Injectable()
export class SnapshotJob {
  private readonly logger = new Logger(SnapshotJob.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly snapshots: SnapshotService,
    private readonly config: ConfigService,
  ) {}

  @Cron('15 0 * * *', { timeZone: 'UTC' })
  async tick(): Promise<void> {
    if (process.env.WORKER_MODE !== 'true') return;
    if (this.config.get<boolean>('reports.enabled') !== true) return;

    const date = snapshotDateFor(new Date());
    await this.dataSource.transaction(async (em) => {
      const rows = await em.query<{ got: boolean }[]>(
        'SELECT pg_try_advisory_xact_lock(1, $1) AS got',
        [LockKey.REPORT_SNAPSHOT],
      );
      if (rows[0]?.got !== true) {
        this.logger.log('[reports] another worker holds the snapshot lock');
        return;
      }
      await this.snapshots.computeAndPersist(date);
    });
  }
}
