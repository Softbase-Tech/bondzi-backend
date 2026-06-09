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

    // CRITICAL ordering: `.where()` REPLACES the existing WHERE clause
    // in TypeORM, while `.andWhere()` appends. The previous version
    // called `.andWhere(...)` first to set up the user-side filters
    // (deleted_at IS NULL, is_active = true) and THEN `.where('lb.exam_type ...')` —
    // which silently dropped the user-side filters and let banned /
    // soft-deleted accounts ghost the public board. Start with `.where()`
    // to seed the clause, then append every other condition with
    // `.andWhere()`.
    const rows = await this.entriesRepo
      .createQueryBuilder('lb')
      .innerJoin('lb.user', 'u')
      .where('lb.exam_type = :et', { et: opts.examType })
      .andWhere('lb.period_type = :pt', { pt: periodType })
      .andWhere('lb.period_start = :ps', { ps: periodStart })
      .andWhere('lb.scope = :scope', { scope })
      .andWhere('u.deleted_at is null')
      .andWhere('u.is_active = true')
      // Skip rows where the joined user has no display name — a NULL
      // `full_name` would crash the mobile's render (initials() calls
      // `.trim()` on the string). It also has no useful display value.
      .andWhere('u.full_name is not null')
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

    // Previously fetched the FULL ranked board into memory (50k+ rows at
    // scale) just to find one user. Wrap the RANK() window in a CTE and
    // SELECT only the target user's row — Postgres still computes the
    // window once on the inner scan, but pushes only 1 row + total
    // back across the wire.
    // CRITICAL: exclude soft-deleted users from the ranking — otherwise
    // a banned account that earned XP earlier this week still occupies
    // a rank slot and shifts every legit user down.
    interface RankRow {
      user_id: string;
      weekly_xp: string;
      rank: string;
      total: string;
    }
    const rows: RankRow[] = await this.entriesRepo.manager.query(
      `
        with ranked as (
          select
            lb.user_id,
            lb.weekly_xp,
            rank() over (
              order by lb.weekly_xp desc, lb.created_at asc
            ) as rank,
            count(*) over () as total
          from leaderboard_entries lb
          inner join users u on u.id = lb.user_id
          where lb.exam_type = $1
            and lb.period_type = $2
            and lb.period_start = $3
            and lb.scope = $4
            and u.deleted_at is null
            and u.is_active = true
        )
        select user_id, weekly_xp, rank, total
        from ranked
        where user_id = $5
        limit 1;
      `,
      [opts.examType, periodType, periodStart, scope, userId],
    );

    if (!rows || rows.length === 0) {
      // User isn't on the board this period. Still need the total — one
      // cheap COUNT (much cheaper than the previous "load everything"
      // path even when the user is missing).
      const totalRow: { total: number }[] =
        await this.entriesRepo.manager.query(
          `
          select count(*)::int as total
          from leaderboard_entries lb
          inner join users u on u.id = lb.user_id
          where lb.exam_type = $1
            and lb.period_type = $2
            and lb.period_start = $3
            and lb.scope = $4
            and u.deleted_at is null
            and u.is_active = true;
        `,
          [opts.examType, periodType, periodStart, scope],
        );
      return {
        userId,
        rank: null,
        weeklyXp: 0,
        total: totalRow[0]?.total ?? 0,
        periodStart,
        periodType,
        scope,
        examType: opts.examType,
      };
    }

    const me = rows[0];
    return {
      userId,
      rank: parseInt(me.rank, 10),
      weeklyXp: parseInt(me.weekly_xp, 10),
      total: parseInt(me.total, 10),
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
