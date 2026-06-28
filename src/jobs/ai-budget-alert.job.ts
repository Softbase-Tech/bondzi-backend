import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '../common/redis/redis.service';
import { CacheKeys } from '../common/utils/cache-keys.util';
import { todayUtcDateKey } from '../modules/ai/ai-cost.util';
import { AdminAlertService } from '../modules/mail/admin-alert.service';

/**
 * Spec §6.5 — checks daily AI spend at 23:00 UTC and alerts when we cross
 * 80% of the configured budget.
 */
@Injectable()
export class AiBudgetAlertJob {
  private readonly logger = new Logger(AiBudgetAlertJob.name);

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly adminAlerts: AdminAlertService,
  ) {}

  @Cron('0 23 * * *', { timeZone: 'UTC' })
  async check(): Promise<void> {
    if (process.env.WORKER_MODE !== 'true') return;
    const dateKey = todayUtcDateKey();
    const dailyBudgetUsd = this.config.get<number>('ai.dailyBudgetUsd') ?? 50;
    const raw = await this.redis.get(CacheKeys.aiCostDay(dateKey));
    const total = raw ? parseFloat(raw) : 0;
    const pct = total / dailyBudgetUsd;

    if (pct >= 1.0) {
      const msg = `100%+ of daily budget spent (${total.toFixed(2)} / ${dailyBudgetUsd} USD). Generation is disabled for the rest of the day.`;
      this.logger.error(`[ai-budget] ${msg}`);
      await this.adminAlerts.send('AI budget exceeded', msg);
    } else if (pct >= 0.8) {
      const msg = `80%+ daily budget ($${total.toFixed(2)} / $${dailyBudgetUsd}).`;
      this.logger.warn(`[ai-budget] ${msg}`);
      await this.adminAlerts.send('AI budget warning', msg);
    } else {
      this.logger.log(
        `[ai-budget] daily spend $${total.toFixed(2)} / $${dailyBudgetUsd} (${(pct * 100).toFixed(1)}%).`,
      );
    }
  }
}
