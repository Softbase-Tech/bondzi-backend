import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LeaderboardEntry } from './entities/leaderboard-entry.entity';
import { RedisService } from '../../common/redis/redis.service';
import { CacheKeys } from '../../common/utils/cache-keys.util';
import { ExamType, LeaderboardPeriodType } from '../../common/types/enums';

const LB_CACHE_TTL_SECONDS = 5 * 60;

export interface LeaderboardRow {
  userId: string;
  fullName: string;
  score: number;
  rank: number;
}

export interface LeaderboardQueryOptions {
  examType: ExamType;
  periodType?: LeaderboardPeriodType;
  scope?: string; // 'national' | school id
  limit?: number;
}

@Injectable()
export class LeaderboardService {
  constructor(
    @InjectRepository(LeaderboardEntry)
    private readonly entriesRepo: Repository<LeaderboardEntry>,
    private readonly redis: RedisService,
  ) {}

  /**
   * Top rows for a given exam_type, scope, and period. Dual boards: BECE and
   * WASSCE are always queried separately.
   */
  async topForPeriod(
    periodStart: string,
    opts: LeaderboardQueryOptions,
  ): Promise<LeaderboardRow[]> {
    const periodType = opts.periodType ?? LeaderboardPeriodType.WEEKLY;
    const scope = opts.scope ?? 'national';
    const cacheKey = CacheKeys.leaderboardWeekly(
      `${opts.examType}:${periodType}:${periodStart}:${scope}`,
    );
    const cached = await this.redis.getJson<LeaderboardRow[]>(cacheKey);
    if (cached) return cached;

    const rows = await this.entriesRepo
      .createQueryBuilder('lb')
      .innerJoin('lb.user', 'u')
      .where('lb.exam_type = :et', { et: opts.examType })
      .andWhere('lb.period_type = :pt', { pt: periodType })
      .andWhere('lb.period_start = :ps', { ps: periodStart })
      .andWhere('lb.scope = :scope', { scope })
      .select('lb.user_id', 'userId')
      .addSelect('u.full_name', 'fullName')
      .addSelect('lb.weekly_xp', 'score')
      .addSelect('lb.rank', 'rank')
      .orderBy('lb.weekly_xp', 'DESC')
      .limit(opts.limit ?? 100)
      .getRawMany<LeaderboardRow>();

    await this.redis.setJson(cacheKey, rows, LB_CACHE_TTL_SECONDS);
    return rows;
  }

  /**
   * Current user's rank for the given period. Computed via a single
   * ranked CTE so the reply is cheap and accurate regardless of how many
   * rows sit above them.
   *
   * Returns `{ rank: null, weeklyXp: 0 }` when the user hasn't earned any XP
   * in the period yet — the mobile app renders that as "Unranked".
   */
  async myRank(
    userId: string,
    periodStart: string,
    opts: Omit<LeaderboardQueryOptions, 'limit'>,
  ): Promise<{
    userId: string;
    rank: number | null;
    weeklyXp: number;
    total: number;
    periodStart: string;
    periodType: LeaderboardPeriodType;
    scope: string;
    examType: ExamType;
  }> {
    const periodType = opts.periodType ?? LeaderboardPeriodType.WEEKLY;
    const scope = opts.scope ?? 'national';

    const ranked = await this.entriesRepo
      .createQueryBuilder('lb')
      .select('lb.user_id', 'userId')
      .addSelect('lb.weekly_xp', 'weeklyXp')
      .addSelect(
        'RANK() OVER (ORDER BY lb.weekly_xp DESC, lb.created_at ASC)',
        'rank',
      )
      .where('lb.exam_type = :et', { et: opts.examType })
      .andWhere('lb.period_type = :pt', { pt: periodType })
      .andWhere('lb.period_start = :ps', { ps: periodStart })
      .andWhere('lb.scope = :scope', { scope })
      .getRawMany<{ userId: string; weeklyXp: string; rank: string }>();

    const mine = ranked.find((r) => r.userId === userId);
    return {
      userId,
      rank: mine ? parseInt(mine.rank, 10) : null,
      weeklyXp: mine ? parseInt(mine.weeklyXp, 10) : 0,
      total: ranked.length,
      periodStart,
      periodType,
      scope,
      examType: opts.examType,
    };
  }

  /** Placeholder until the scheduled period-rollover job lands. */
  snapshotWeek(periodStart: string): Promise<void> {
    void periodStart;
    return Promise.resolve();
  }
}
