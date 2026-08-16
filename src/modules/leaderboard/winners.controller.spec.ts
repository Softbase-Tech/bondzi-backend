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
      listCurrentPeriodWinners: jest.fn(),
      allTimeHallOfFame: jest.fn(),
    } as unknown as jest.Mocked<WinnerSelectionService>;
    const moduleRef = await Test.createTestingModule({
      controllers: [WinnersController],
      providers: [{ provide: WinnerSelectionService, useValue: winners }],
    }).compile();
    controller = moduleRef.get(WinnersController);
  });

  it('list scopes to the caller examType (client cannot widen it)', () => {
    controller.list(
      { id: 'u1', examType: ExamType.BECE } as never,
      LeaderboardPeriodType.WEEKLY,
      '2026-05-11',
    );
    expect(winners.listPast).toHaveBeenCalledWith({
      examType: ExamType.BECE,
      periodType: LeaderboardPeriodType.WEEKLY,
      periodStart: '2026-05-11',
    });
    expect(winners.listCurrentPeriodWinners).not.toHaveBeenCalled();
  });

  it('list defaults to WASSCE when the user has no examType', () => {
    controller.list({ id: 'u1' } as never, LeaderboardPeriodType.WEEKLY);
    expect(winners.listCurrentPeriodWinners).toHaveBeenCalledWith(
      expect.objectContaining({ examType: ExamType.WASSCE }),
    );
    expect(winners.listPast).not.toHaveBeenCalled();
  });

  it('list without a periodStart returns only the latest period', () => {
    // Previously this fell through to listPast with no filter, which
    // returned every winner across every period and rendered as
    // duplicate rows on the mobile winners tab.
    controller.list(
      { id: 'u1', examType: ExamType.WASSCE } as never,
      LeaderboardPeriodType.WEEKLY,
    );
    expect(winners.listCurrentPeriodWinners).toHaveBeenCalledWith({
      examType: ExamType.WASSCE,
      periodType: LeaderboardPeriodType.WEEKLY,
    });
    expect(winners.listPast).not.toHaveBeenCalled();
  });

  it('hallOfFame uses the caller examType', () => {
    controller.hallOfFame({ id: 'u1', examType: ExamType.BECE } as never);
    expect(winners.allTimeHallOfFame).toHaveBeenCalledWith(ExamType.BECE);
  });
});
