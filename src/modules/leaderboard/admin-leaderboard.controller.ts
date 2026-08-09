import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExcludeController,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  ExamType,
  LeaderboardPeriodType,
  UserRole,
} from '../../common/types/enums';
import {
  accraMondayIso,
  accraMonthStartIso,
} from '../../common/utils/timezone.util';
import { LeaderboardService } from './leaderboard.service';
import { WinnerSelectionService } from './winner-selection.service';
import { SelectWinnersDto } from './dto/select-winners.dto';

@ApiTags('admin-leaderboard')
@ApiExcludeController()
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('admin/leaderboard')
export class AdminLeaderboardController {
  constructor(
    private readonly winners: WinnerSelectionService,
    private readonly leaderboard: LeaderboardService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Top-N leaderboard for the given exam_type + period (admin view). ' +
      'Mirrors GET /leaderboard but role-gated to admin/superadmin so ' +
      'an admin can inspect ANY board regardless of their own examType.',
  })
  list(
    @Query('examType') examTypeParam?: string,
    @Query('periodType') periodTypeParam?: string,
    @Query('periodStart') periodStartParam?: string,
    @Query('scope') scope?: string,
    @Query('limit') limitParam?: string,
  ) {
    const examType =
      examTypeParam &&
      Object.values(ExamType).includes(examTypeParam as ExamType)
        ? (examTypeParam as ExamType)
        : ExamType.WASSCE;
    const periodType =
      periodTypeParam === LeaderboardPeriodType.MONTHLY
        ? LeaderboardPeriodType.MONTHLY
        : LeaderboardPeriodType.WEEKLY;
    const periodStart =
      periodStartParam ??
      (periodType === LeaderboardPeriodType.MONTHLY
        ? accraMonthStartIso()
        : accraMondayIso());
    const parsed = limitParam ? parseInt(limitParam, 10) : 100;
    const limit =
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 100;
    return this.leaderboard.topForPeriod(periodStart, {
      examType,
      periodType,
      scope: scope || 'national',
      limit,
    });
  }

  @Post('select-winners')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Admin-triggered winner selection for a just-ended period. Idempotent: refuses re-runs.',
  })
  select(@Body() dto: SelectWinnersDto) {
    return this.winners.selectWinners(dto);
  }
}
