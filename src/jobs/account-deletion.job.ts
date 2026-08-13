import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { AccountDeletionsService } from '../modules/account-deletions/account-deletions.service';

/**
 * Daily account-deletion sweep: schedule inactive accounts, cancel the ones
 * that came back, send the T-14 / T-7 warnings, and anonymise anything whose
 * grace has elapsed — then email the admin digest.
 *
 * Worker-only, guarded by a session-level advisory lock so multiple worker
 * replicas don't run it twice. A session lock (not the xact variant) is used
 * because the sweep runs its own per-user transactions internally.
 */
@Injectable()
export class AccountDeletionJob {
  private readonly logger = new Logger(AccountDeletionJob.name);
  private static readonly LOCK_KEY = 17_009;

  constructor(
    private readonly dataSource: DataSource,
    private readonly deletions: AccountDeletionsService,
  ) {}

  @Cron('30 3 * * *', { timeZone: 'Africa/Accra' })
  async tick(): Promise<void> {
    if (process.env.WORKER_MODE !== 'true') return;

    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      const rows = (await runner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [AccountDeletionJob.LOCK_KEY],
      )) as Array<{ locked: boolean }>;
      if (rows[0]?.locked !== true) {
        this.logger.log('[acct-del] another worker holds the lock; skipping');
        return;
      }
      try {
        const s = await this.deletions.runDailySweep();
        this.logger.log(
          `[acct-del] scheduled=${s.scheduled} cancelled=${s.cancelled} warned=${s.warned} deleted=${s.deleted}`,
        );
      } catch (err) {
        this.logger.error(
          `[acct-del] sweep failed: ${(err as Error).message}`,
        );
      } finally {
        await runner.query('SELECT pg_advisory_unlock($1)', [
          AccountDeletionJob.LOCK_KEY,
        ]);
      }
    } finally {
      await runner.release();
    }
  }
}
