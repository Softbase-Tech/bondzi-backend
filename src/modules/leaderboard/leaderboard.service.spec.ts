import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LeaderboardService } from './leaderboard.service';
import { LeaderboardEntry } from './entities/leaderboard-entry.entity';
import { RedisService } from '../../common/redis/redis.service';
import { ExamType, LeaderboardPeriodType } from '../../common/types/enums';

/**
 *  - topForPeriod: serves the Redis cache when warm; on miss runs the query
 *    and writes the result back with TTL.
 *  - myRank: returns the user's rank from the windowed CTE result, or null
 *    when the user hasn't earned any XP in the period yet.
 */

describe('LeaderboardService', () => {
  let service: LeaderboardService;
  let entriesRepo: { createQueryBuilder: jest.Mock };
  let redis: { getJson: jest.Mock; setJson: jest.Mock };

  beforeEach(async () => {
    entriesRepo = { createQueryBuilder: jest.fn() };
    redis = { getJson: jest.fn(), setJson: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        LeaderboardService,
        {
          provide: getRepositoryToken(LeaderboardEntry),
          useValue: entriesRepo,
        },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();
    service = moduleRef.get(LeaderboardService);
  });

  function topQbReturns(rows: unknown[]) {
    entriesRepo.createQueryBuilder.mockReturnValueOnce({
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rows),
    });
  }

  function rankedQbReturns(rows: unknown[]) {
    entriesRepo.createQueryBuilder.mockReturnValueOnce({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rows),
    });
  }

  // ----------------------------- topForPeriod -----------------------------

  it('returns the cached rows without querying the DB on a cache hit', async () => {
    redis.getJson.mockResolvedValueOnce([
      { userId: 'u', fullName: 'X', score: 100, rank: 1 },
    ]);
    const out = await service.topForPeriod('2026-W19', {
      examType: ExamType.WASSCE,
    });
    expect(out).toHaveLength(1);
    expect(entriesRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('on cache miss queries the DB and writes the result back with TTL', async () => {
    redis.getJson.mockResolvedValueOnce(null);
    topQbReturns([{ userId: 'u', fullName: 'X', score: 50, rank: 1 }]);
    const out = await service.topForPeriod('2026-W19', {
      examType: ExamType.WASSCE,
    });
    expect(out).toHaveLength(1);
    expect(redis.setJson).toHaveBeenCalledWith(
      expect.any(String),
      out,
      expect.any(Number),
    );
  });

  // -------------------------------- myRank --------------------------------

  it('returns the rank for a user who appears in the period', async () => {
    rankedQbReturns([
      { userId: 'other', weeklyXp: '100', rank: '1' },
      { userId: 'user-1', weeklyXp: '90', rank: '2' },
    ]);
    const out = await service.myRank('user-1', '2026-W19', {
      examType: ExamType.WASSCE,
    });
    expect(out).toEqual(
      expect.objectContaining({
        userId: 'user-1',
        rank: 2,
        weeklyXp: 90,
        total: 2,
      }),
    );
  });

  it('returns rank: null when the user has not earned any XP in the period', async () => {
    rankedQbReturns([{ userId: 'other', weeklyXp: '100', rank: '1' }]);
    const out = await service.myRank('user-1', '2026-W19', {
      examType: ExamType.WASSCE,
    });
    expect(out.rank).toBeNull();
    expect(out.weeklyXp).toBe(0);
    expect(out.total).toBe(1);
  });

  it('defaults periodType to WEEKLY and scope to "national"', async () => {
    rankedQbReturns([]);
    const out = await service.myRank('user-1', '2026-W19', {
      examType: ExamType.BECE,
    });
    expect(out.periodType).toBe(LeaderboardPeriodType.WEEKLY);
    expect(out.scope).toBe('national');
  });
});
