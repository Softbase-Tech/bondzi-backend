import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ExamType, LeaderboardPeriodType } from '../../common/types/enums';
import { WinnerSelectionService } from './winner-selection.service';

@ApiTags('leaderboard-winners')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('leaderboard/winners')
export class WinnersController {
  constructor(private readonly winners: WinnerSelectionService) {}

  @Get()
  @ApiOperation({
    summary:
      'Past winners for an examType + periodType (+ optional periodStart).',
  })
  list(
    @Query('examType') examType: ExamType,
    @Query('periodType') periodType: LeaderboardPeriodType,
    @Query('periodStart') periodStart?: string,
  ) {
    return this.winners.listPast({ examType, periodType, periodStart });
  }

  @Get('all-time')
  @ApiOperation({
    summary: 'Top 20 all-time winners by win count for the given examType.',
  })
  hallOfFame(@Query('examType') examType: ExamType) {
    return this.winners.allTimeHallOfFame(examType);
  }
}
