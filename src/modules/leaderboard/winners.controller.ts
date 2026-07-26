import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
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
      "Past winners for the current user's own examType + periodType " +
      '(+ optional periodStart).',
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('periodType') periodType: LeaderboardPeriodType,
    @Query('periodStart') periodStart?: string,
  ) {
    // Winners are scoped to the caller's own exam level — a client-supplied
    // `examType` is ignored so users only ever see their level's winners.
    const examType = user.examType ?? ExamType.WASSCE;
    return this.winners.listPast({ examType, periodType, periodStart });
  }

  @Get('all-time')
  @ApiOperation({
    summary:
      "Top 20 all-time winners by win count for the current user's examType.",
  })
  hallOfFame(@CurrentUser() user: AuthenticatedUser) {
    const examType = user.examType ?? ExamType.WASSCE;
    return this.winners.allTimeHallOfFame(examType);
  }
}
