import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '../common/redis/redis.service';
import { CacheKeys } from '../common/utils/cache-keys.util';
import { todayUtcDateKey } from '../modules/ai/ai-cost.util';

/**
 * Spec §6.5 — checks daily AI spend at 23:00 UTC and alerts when we cross
 * 80% of the configured budget. Over 100% disables generation — that's
 * enforced in AiService.checkBudget on every request; this job emits the
 * operational alert so humans know to act.
 */
@Injectable()
export class AiBudgetAlertJob {
  private readonly logger = new Logger(AiBudgetAlertJob.name);

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  @Cron('0 23 * * *', { timeZone: 'UTC' })
  async check(): Promise<void> {
    const dateKey = todayUtcDateKey();
    const dailyBudgetUsd = this.config.get<number>('ai.dailyBudgetUsd') ?? 50;
    const raw = await this.redis.get(CacheKeys.aiCostDay(dateKey));
    const total = raw ? parseFloat(raw) : 0;
    const pct = total / dailyBudgetUsd;

    if (pct >= 1.0) {
      this.logger.error(
        `[ai-budget] 100%+ of daily budget spent (${total.toFixed(2)} / ${dailyBudgetUsd} USD). Generation is disabled for the rest of the day.`,
      );
    } else if (pct >= 0.8) {
      this.logger.warn(
        `[ai-budget] 80%+ daily budget ($${total.toFixed(2)} / $${dailyBudgetUsd}).`,
      );
    } else {
      this.logger.log(
        `[ai-budget] daily spend $${total.toFixed(2)} / $${dailyBudgetUsd} (${(pct * 100).toFixed(1)}%).`,
      );
    }
  }
}
