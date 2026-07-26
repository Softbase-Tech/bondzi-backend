import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { LeaderboardService } from './leaderboard.service';
import { ExamType, LeaderboardPeriodType } from '../../common/types/enums';
import {
  accraMondayIso,
  accraMonthStartIso,
} from '../../common/utils/timezone.util';

function resolvePeriodType(param: string | undefined): LeaderboardPeriodType {
  return param === LeaderboardPeriodType.MONTHLY
    ? LeaderboardPeriodType.MONTHLY
    : LeaderboardPeriodType.WEEKLY;
}

function resolvePeriodStart(
  periodStart: string | undefined,
  periodType: LeaderboardPeriodType,
): string {
  if (periodStart) return periodStart;
  return periodType === LeaderboardPeriodType.MONTHLY
    ? accraMonthStartIso()
    : accraMondayIso();
}

@ApiTags('leaderboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('leaderboard')
export class LeaderboardController {
  constructor(private readonly leaderboard: LeaderboardService) {}

  @Get()
  @ApiOperation({
    summary:
      "Top 100 leaderboard for the current user's own examType. " +
      'Supports weekly/monthly. Cached 5m.',
  })
  top(
    @CurrentUser() user: AuthenticatedUser,
    @Query('periodType') periodTypeParam?: string,
    @Query('scope') scope?: string,
    @Query('periodStart') periodStart?: string,
  ) {
    // Locked to the caller's own exam level: a user only ever sees their
    // own board (a WASSCE account cannot view BECE, etc.). Any client
    // `examType` is intentionally ignored so the scope can't be widened.
    const examType = user.examType ?? ExamType.WASSCE;
    const periodType = resolvePeriodType(periodTypeParam);
    const effectiveStart = resolvePeriodStart(periodStart, periodType);
    return this.leaderboard.topForPeriod(effectiveStart, {
      examType,
      periodType,
      scope: scope || 'national',
    });
  }

  @Get('my-rank')
  @ApiOperation({
    summary:
      "Current user's rank + XP for the current (or explicit) period. " +
      'Returns rank=null when the user has not earned any XP in the period.',
  })
  myRank(
    @CurrentUser() user: AuthenticatedUser,
    @Query('periodType') periodTypeParam?: string,
    @Query('scope') scope?: string,
    @Query('periodStart') periodStart?: string,
  ) {
    // Same exam-level lock as `top` — rank is always within the user's
    // own board.
    const examType = user.examType ?? ExamType.WASSCE;
    const periodType = resolvePeriodType(periodTypeParam);
    const effectiveStart = resolvePeriodStart(periodStart, periodType);
    return this.leaderboard.myRank(user.id, effectiveStart, {
      examType,
      periodType,
      scope: scope || 'national',
    });
  }
}
