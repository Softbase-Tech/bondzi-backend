import { Test } from '@nestjs/testing';
import { AdminLeaderboardController } from './admin-leaderboard.controller';
import { WinnerSelectionService } from './winner-selection.service';

describe('AdminLeaderboardController', () => {
  it('POST /admin/leaderboard/select-winners forwards the DTO untouched', async () => {
    const winners = { selectWinners: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminLeaderboardController],
      providers: [{ provide: WinnerSelectionService, useValue: winners }],
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
});
