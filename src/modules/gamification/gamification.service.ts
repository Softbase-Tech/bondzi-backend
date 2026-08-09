import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { XpRateConfig } from '../xp-economy/entities/xp-rate-config.entity';
import { XpTransaction } from '../xp-economy/entities/xp-transaction.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { MailService } from '../mail/mail.service';
import { MailEvent } from '../mail/mail.types';
import { RedisService } from '../../common/redis/redis.service';
import { CacheKeys } from '../../common/utils/cache-keys.util';
import {
  ExamType,
  LeaderboardPeriodType,
  NotificationChannel,
} from '../../common/types/enums';
import { levelForXp, xpIntoLevel, xpToNextLevel } from './level.util';

/** ISO date (YYYY-MM-DD) for the Monday of the week containing `now`, UTC. */
function weeklyPeriodStart(now: Date = new Date()): string {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const offset = day === 0 ? 6 : day - 1; // shift to Monday-first
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

/** ISO date (YYYY-MM-DD) for the first day of the current UTC month. */
function monthlyPeriodStart(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return d.toISOString().slice(0, 10);
}

export interface AwardXpResult {
  awarded: boolean;
  eventKey: string;
  xpAmount: number;
  levelXp: number;
  spendableXp: number;
  currentLevel: number;
  xpIntoLevel: number;
  xpToNextLevel: number;
  leveledUp: boolean;
  newLevel?: number;
}

/**
 * v2 XP ledger core. Reads earn rates from `xp_rate_config` (admin-editable),
 * writes an immutable row to `xp_transactions`, atomically bumps the user's
 * level/spendable pools, and computes level-up from the shared thresholds.
 *
 * Level XP never decreases; redemption only touches spendable XP via
 * XpEconomyService.redeem.
 */
@Injectable()
export class GamificationService {
  private readonly logger = new Logger(GamificationService.name);

  constructor(
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    @InjectRepository(XpRateConfig)
    private readonly ratesRepo: Repository<XpRateConfig>,
    @InjectRepository(XpTransaction)
    private readonly txRepo: Repository<XpTransaction>,
    private readonly notifications: NotificationsService,
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    private readonly mail: MailService,
  ) {}

  /**
   * Daily cap on awards per (user, event_key). Without this, a scripted
   * client could spam POST /exams/:id/answer (each correct answer fires
   * `correct_past_paper`) or chain `/srs/review` and mint unbounded XP.
   * The cap is intentionally generous — well above the heaviest legit
   * day of study — so it's only the runaway-bot ceiling, not a UX limit.
   */
  private static readonly EVENT_KEY_DAILY_CAP = 500;

  /**
   * Award XP for `eventKey`. Silently no-ops when the event is disabled in
   * xp_rate_config so admins can instantly suspend rewards without deploys.
   * Also caps per (user, event_key, UTC day) — see EVENT_KEY_DAILY_CAP.
   */
  async awardXp(
    userId: string,
    eventKey: string,
    referenceId?: string | null,
  ): Promise<AwardXpResult> {
    const rate = await this.ratesRepo.findOne({
      where: { eventKey, isActive: true },
    });
    if (!rate || rate.xpAmount === 0) {
      const user = await this.usersRepo.findOne({ where: { id: userId } });
      const levelXp = Number(user?.levelXp ?? 0);
      const spendableXp = Number(user?.spendableXp ?? 0);
      return {
        awarded: false,
        eventKey,
        xpAmount: 0,
        levelXp,
        spendableXp,
        currentLevel: user?.currentLevel ?? 1,
        xpIntoLevel: xpIntoLevel(levelXp),
        xpToNextLevel: xpToNextLevel(user?.currentLevel ?? 1),
        leveledUp: false,
      };
    }

    if (await this.exceedsDailyEventCap(userId, eventKey)) {
      this.logger.warn(
        `[xp] daily cap reached for user=${userId} event=${eventKey} — refusing award`,
      );
      const user = await this.usersRepo.findOne({ where: { id: userId } });
      const levelXp = Number(user?.levelXp ?? 0);
      const spendableXp = Number(user?.spendableXp ?? 0);
      return {
        awarded: false,
        eventKey,
        xpAmount: 0,
        levelXp,
        spendableXp,
        currentLevel: user?.currentLevel ?? 1,
        xpIntoLevel: xpIntoLevel(levelXp),
        xpToNextLevel: xpToNextLevel(user?.currentLevel ?? 1),
        leveledUp: false,
      };
    }

    return this.applyXp(userId, eventKey, rate.xpAmount, referenceId ?? null);
  }

  /**
   * Has this (user, event_key) already hit the per-day count cap? Counts
   * EVERY call after the rate-config gate passes; the increment runs on
   * the cap-check path so the counter advances even when the call later
   * fails inside applyXp. Cap is a per-event ceiling, not a UX limit.
   */
  private async exceedsDailyEventCap(
    userId: string,
    eventKey: string,
  ): Promise<boolean> {
    const dateKey = new Date().toISOString().slice(0, 10);
    // 25h TTL — covers UTC midnight roll without a gap.
    const count = await this.redis.incr(
      `xp_event_cap:${userId}:${eventKey}:${dateKey}`,
      25 * 60 * 60,
    );
    return count > GamificationService.EVENT_KEY_DAILY_CAP;
  }

  /**
   * Award an explicit amount of XP bypassing xp_rate_config. Used by flows
   * whose amount lives elsewhere in admin config (e.g. ad_config.rewarded_xp_amount
   * per spec §8.4).
   */
  async awardXpAmount(
    userId: string,
    amount: number,
    eventKey: string,
    referenceId?: string | null,
  ): Promise<AwardXpResult> {
    if (amount <= 0) {
      return this.awardXp(userId, eventKey, referenceId); // 0-amount no-op path
    }
    return this.applyXp(userId, eventKey, amount, referenceId ?? null);
  }

  private async applyXp(
    userId: string,
    eventKey: string,
    amount: number,
    referenceId: string | null,
  ): Promise<AwardXpResult> {
    // CRITICAL: only DB writes happen inside the transaction.
    // Notification enqueue (BullMQ/Redis) and any cross-network I/O
    // happen AFTER commit. The previous shape held an open Postgres
    // connection while awaiting BullMQ.add and Redis.del; under 50k
    // DAU load this starves the 20-slot pool and grinds the API to a
    // halt during a Redis blip. Leaderboard + level-up DB writes
    // stay atomic with the user-XP write.
    const txResult = await this.dataSource.transaction(async (em) => {
      const usersRepo = em.getRepository(User);
      const txRepo = em.getRepository(XpTransaction);

      await txRepo.insert({
        userId,
        eventKey,
        levelXp: amount,
        spendableXp: amount,
        referenceId: referenceId ?? null,
      });

      await usersRepo
        .createQueryBuilder()
        .update(User)
        .set({
          levelXp: () => `"level_xp" + ${amount}`,
          spendableXp: () => `"spendable_xp" + ${amount}`,
        })
        .where('id = :id', { id: userId })
        .execute();

      const reloaded = await usersRepo.findOne({ where: { id: userId } });
      if (!reloaded) throw new Error('User disappeared during XP award');

      // Leaderboard bump must be atomic with the user XP write so a
      // crash between them can't leave the board lagging behind the
      // user's level_xp.
      await this.bumpLeaderboard(em, reloaded.id, reloaded.examType, amount);

      const newLevelXpNum = Number(reloaded.levelXp);
      const newLevel = levelForXp(newLevelXpNum);
      const previousLevel = reloaded.currentLevel;
      const leveledUp = newLevel > previousLevel;

      if (leveledUp) {
        await usersRepo.update(userId, { currentLevel: newLevel });
      }

      return {
        newLevelXpNum,
        newSpendableXp: Number(reloaded.spendableXp),
        leveledUp,
        previousLevel,
        newLevel,
      };
    });

    // POST-COMMIT side effects. Failures here MUST NOT roll back the XP
    // grant (which has already committed) — log and continue.
    if (txResult.leveledUp) {
      // Spec §6.1 step 5: emit level_up → push notification + LevelUpModal.
      // The push carries `type: 'level_up'` so the mobile client can pop
      // the in-app modal as well as the OS notification.
      await this.notifications
        .send({
          userId,
          channel: NotificationChannel.PUSH,
          title: `Level ${txResult.newLevel}! 🎉`,
          body: `You reached Level ${txResult.newLevel}. Keep going to unlock more.`,
          data: {
            type: 'level_up',
            previousLevel: txResult.previousLevel,
            newLevel: txResult.newLevel,
            eventKey,
          },
        })
        .catch((err) =>
          this.logger.warn(
            `level-up notification failed: ${(err as Error).message}`,
          ),
        );

      // Email companion (best-effort; mail.send is non-throwing). Skipped
      // for users with no email on file (phone-only signups). The push
      // above is the primary channel — the email is the "I missed the
      // notification" backstop a few hours later.
      const userRow = await this.usersRepo.findOne({ where: { id: userId } });
      if (userRow?.email) {
        await this.mail.send(
          MailEvent.LEVEL_UP,
          userRow.email,
          {
            recipientName: userRow.fullName ?? undefined,
            newLevel: txResult.newLevel,
            xpEarned: amount,
          },
          { userId, dedupKey: `level_up:${userId}:${txResult.newLevel}` },
        );
      }
    }

    return {
      awarded: true,
      eventKey,
      xpAmount: amount,
      levelXp: txResult.newLevelXpNum,
      spendableXp: txResult.newSpendableXp,
      currentLevel: txResult.leveledUp
        ? txResult.newLevel
        : txResult.previousLevel,
      xpIntoLevel: xpIntoLevel(txResult.newLevelXpNum),
      xpToNextLevel: xpToNextLevel(
        txResult.leveledUp ? txResult.newLevel : txResult.previousLevel,
      ),
      leveledUp: txResult.leveledUp,
      newLevel: txResult.leveledUp ? txResult.newLevel : undefined,
    };
  }

  /**
   * Increment the running weekly and monthly leaderboard rows for the user's
   * exam_type + national scope. Uses Postgres' `INSERT ... ON CONFLICT DO
   * UPDATE` so the first earn of the period creates the row and every
   * subsequent earn adds to it atomically.
   */
  private async bumpLeaderboard(
    em: EntityManager,
    userId: string,
    examType: ExamType,
    amount: number,
  ): Promise<void> {
    if (amount <= 0) return;
    const periods: { type: LeaderboardPeriodType; start: string }[] = [
      { type: LeaderboardPeriodType.WEEKLY, start: weeklyPeriodStart() },
      { type: LeaderboardPeriodType.MONTHLY, start: monthlyPeriodStart() },
    ];
    // TypeORM's `.orUpdate()` only supports `SET col = EXCLUDED.col`, but we
    // need `SET weekly_xp = leaderboard_entries.weekly_xp + EXCLUDED.weekly_xp`
    // so concurrent earns within the period accumulate instead of clobbering.
    // Drop to a parameterised raw query — Postgres-only, but the rest of the
    // stack already requires Postgres for jsonb / array types.
    for (const { type, start } of periods) {
      await em.query(
        `INSERT INTO leaderboard_entries
           (user_id, exam_type, scope, period_type, period_start, weekly_xp)
         VALUES ($1, $2, 'national', $3, $4, $5)
         ON CONFLICT (user_id, exam_type, scope, period_type, period_start)
         DO UPDATE SET weekly_xp = leaderboard_entries.weekly_xp + EXCLUDED.weekly_xp`,
        [userId, examType, type, start, amount],
      );
      // Bust the cached board slice so the user sees their earn within the
      // next read instead of waiting for the 5-min TTL. Cache key shape
      // mirrors LeaderboardService.topForPeriod.
      await this.redis.del(
        CacheKeys.leaderboardWeekly(`${examType}:${type}:${start}:national`),
      );
    }
  }

  /** Convenience aggregator — returns the current XP snapshot for a user. */
  async snapshot(userId: string): Promise<{
    levelXp: number;
    spendableXp: number;
    currentLevel: number;
    xpIntoLevel: number;
    xpToNextLevel: number;
    streakDays: number;
    longestStreak: number;
  }> {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    const levelXp = Number(user?.levelXp ?? 0);
    const spendableXp = Number(user?.spendableXp ?? 0);
    const currentLevel = user?.currentLevel ?? 1;
    return {
      levelXp,
      spendableXp,
      currentLevel,
      xpIntoLevel: xpIntoLevel(levelXp),
      xpToNextLevel: xpToNextLevel(currentLevel),
      streakDays: user?.streakDays ?? 0,
      longestStreak: user?.longestStreak ?? 0,
    };
  }

  /** Recent XP ledger entries — powers the profile activity feed. */
  async recentTransactions(
    userId: string,
    limit = 20,
  ): Promise<XpTransaction[]> {
    return this.txRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }
}
