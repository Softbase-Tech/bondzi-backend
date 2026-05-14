import { Test } from '@nestjs/testing';
import { WinnersController } from './winners.controller';
import { WinnerSelectionService } from './winner-selection.service';
import { ExamType, LeaderboardPeriodType } from '../../common/types/enums';

describe('WinnersController', () => {
  let controller: WinnersController;
  let winners: jest.Mocked<WinnerSelectionService>;

  beforeEach(async () => {
    winners = {
      listPast: jest.fn(),
      allTimeHallOfFame: jest.fn(),
    } as unknown as jest.Mocked<WinnerSelectionService>;
    const moduleRef = await Test.createTestingModule({
      controllers: [WinnersController],
      providers: [{ provide: WinnerSelectionService, useValue: winners }],
    }).compile();
    controller = moduleRef.get(WinnersController);
  });

  it('list forwards (examType, periodType, periodStart) into a single object', () => {
    controller.list(
      ExamType.WASSCE,
      LeaderboardPeriodType.WEEKLY,
      '2026-05-11',
    );
    expect(winners.listPast).toHaveBeenCalledWith({
      examType: ExamType.WASSCE,
      periodType: LeaderboardPeriodType.WEEKLY,
      periodStart: '2026-05-11',
    });
  });

  it('hallOfFame forwards only the examType', () => {
    controller.hallOfFame(ExamType.BECE);
    expect(winners.allTimeHallOfFame).toHaveBeenCalledWith(ExamType.BECE);
  });
});
