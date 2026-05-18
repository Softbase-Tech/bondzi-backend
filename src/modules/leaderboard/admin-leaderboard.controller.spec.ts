import { Test } from '@nestjs/testing';
import { AdminLeaderboardController } from './admin-leaderboard.controller';
import { LeaderboardService } from './leaderboard.service';
import { WinnerSelectionService } from './winner-selection.service';

describe('AdminLeaderboardController', () => {
  it('POST /admin/leaderboard/select-winners forwards the DTO untouched', async () => {
    const winners = { selectWinners: jest.fn() };
    const leaderboard = { topForPeriod: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminLeaderboardController],
      providers: [
        { provide: WinnerSelectionService, useValue: winners },
        { provide: LeaderboardService, useValue: leaderboard },
      ],
    }).compile();
    const controller = moduleRef.get(AdminLeaderboardController);
    await controller.select({
      examType: 'wassce',
      periodType: 'weekly',
      periodStart: '2026-05-11',
    } as never);
    expect(winners.selectWinners).toHaveBeenCalledWith({
      examType: 'wassce',
      periodType: 'weekly',
      periodStart: '2026-05-11',
    });
  });

  it('GET /admin/leaderboard delegates to LeaderboardService.topForPeriod with parsed filters', async () => {
    const winners = { selectWinners: jest.fn() };
    const leaderboard = { topForPeriod: jest.fn().mockResolvedValue([]) };
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminLeaderboardController],
      providers: [
        { provide: WinnerSelectionService, useValue: winners },
        { provide: LeaderboardService, useValue: leaderboard },
      ],
    }).compile();
    const controller = moduleRef.get(AdminLeaderboardController);
    await controller.list('bece', 'monthly', '2026-05-01', 'national', '50');
    expect(leaderboard.topForPeriod).toHaveBeenCalledWith(
      '2026-05-01',
      expect.objectContaining({
        examType: 'bece',
        periodType: 'monthly',
        scope: 'national',
        limit: 50,
      }),
    );
  });

  it('GET /admin/leaderboard clamps limit to 500 and falls back to WASSCE/weekly defaults', async () => {
    const winners = { selectWinners: jest.fn() };
    const leaderboard = { topForPeriod: jest.fn().mockResolvedValue([]) };
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminLeaderboardController],
      providers: [
        { provide: WinnerSelectionService, useValue: winners },
        { provide: LeaderboardService, useValue: leaderboard },
      ],
    }).compile();
    const controller = moduleRef.get(AdminLeaderboardController);
    await controller.list(
      'unrecognised',
      'unknown-period',
      undefined,
      undefined,
      '9999',
    );
    const call = leaderboard.topForPeriod.mock.calls[0];
    // unrecognised exam → wassce default; unknown period → weekly default;
    // periodStart auto-resolved to the current Accra Monday so we only
    // assert it's an ISO date (yyyy-mm-dd).
    expect(call[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(call[1]).toEqual(
      expect.objectContaining({
        examType: 'wassce',
        periodType: 'weekly',
        scope: 'national',
        limit: 500,
      }),
    );
  });
});
