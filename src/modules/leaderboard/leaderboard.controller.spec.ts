import { Test } from '@nestjs/testing';
import { LeaderboardController } from './leaderboard.controller';
import { LeaderboardService } from './leaderboard.service';
import { ExamType, LeaderboardPeriodType } from '../../common/types/enums';

/**
 * Coverage:
 *  - examType is locked to the caller's own `user.examType` (any client
 *    override is ignored), defaulting to WASSCE when absent.
 *  - resolvePeriodType: only MONTHLY counts; everything else defaults to
 *    WEEKLY.
 *  - resolvePeriodStart: explicit `periodStart` query wins; otherwise the
 *    helper picks the appropriate Accra-local Monday / month-start ISO.
 */

describe('LeaderboardController', () => {
  let controller: LeaderboardController;
  let leaderboard: jest.Mocked<LeaderboardService>;

  beforeEach(async () => {
    leaderboard = {
      topForPeriod: jest.fn(),
      myRank: jest.fn(),
    } as unknown as jest.Mocked<LeaderboardService>;

    const moduleRef = await Test.createTestingModule({
      controllers: [LeaderboardController],
      providers: [{ provide: LeaderboardService, useValue: leaderboard }],
    }).compile();
    controller = moduleRef.get(LeaderboardController);
  });

  it('top: uses the caller examType (client cannot widen the scope)', () => {
    controller.top({ id: 'user-1', examType: ExamType.BECE } as never);
    expect(leaderboard.topForPeriod).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ examType: ExamType.BECE }),
    );
  });

  it('top: defaults to WASSCE when the user has no examType', () => {
    controller.top({ id: 'user-1' } as never);
    expect(leaderboard.topForPeriod).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ examType: ExamType.WASSCE }),
    );
  });

  it('top: defaults to weekly when periodType is not MONTHLY', () => {
    controller.top(
      { id: 'user-1', examType: ExamType.WASSCE } as never,
      'weird',
    );
    expect(leaderboard.topForPeriod).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ periodType: LeaderboardPeriodType.WEEKLY }),
    );
  });

  it('top: honours an explicit periodStart query parameter', () => {
    controller.top(
      { id: 'user-1', examType: ExamType.WASSCE } as never,
      undefined,
      undefined,
      '2026-05-04',
    );
    expect(leaderboard.topForPeriod).toHaveBeenCalledWith(
      '2026-05-04',
      expect.any(Object),
    );
  });

  it('top: defaults scope to "national" when missing', () => {
    controller.top({ id: 'user-1', examType: ExamType.WASSCE } as never);
    const [, opts] = leaderboard.topForPeriod.mock.calls[0];
    expect((opts as { scope: string }).scope).toBe('national');
  });

  it('myRank: forwards the user id alongside the resolved period', () => {
    controller.myRank({ id: 'user-1', examType: ExamType.BECE } as never);
    expect(leaderboard.myRank).toHaveBeenCalledWith(
      'user-1',
      expect.any(String),
      expect.objectContaining({ examType: ExamType.BECE }),
    );
  });
});
