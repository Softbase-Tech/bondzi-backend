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
import { WinnerSelectionService } from './winner-selection.service';
import type { Winner } from './entities/winner.entity';

/** Flattened winner shape returned to the admin — adds `userName` and
 * `username` lifted from the joined user so the admin table can render
 * a single object. Mobile reads through `w.user` instead. */
type WinnerWithUserSummary = Winner & {
  userName: string;
  username: string | null;
};

/**
 * Admin "Winners" page surface. The public `/leaderboard/winners`
 * controller is consumer-facing (mobile renders past winners on the
 * leaderboard tab); this one is admin-only, supports optional filters
 * and exposes the candidate-vetting + confirm flow used by the
 * winner-selection modal.
 */
@ApiTags('admin-winners')
@ApiExcludeController()
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('admin/winners')
export class AdminWinnersController {
  constructor(private readonly winners: WinnerSelectionService) {}

  @Get()
  @ApiOperation({
    summary:
      'Past winners across all (or filtered) exam types + period types. ' +
      'Returns a Paginated<Winner> shape so the admin table can render it.',
  })
  async list(
    @Query('examType') examTypeParam?: string,
    @Query('periodType') periodTypeParam?: string,
    @Query('periodStart') periodStartParam?: string,
  ): Promise<{
    items: WinnerWithUserSummary[];
    total: number;
    nextCursor: string | null;
  }> {
    const examType =
      examTypeParam &&
      Object.values(ExamType).includes(examTypeParam as ExamType)
        ? (examTypeParam as ExamType)
        : undefined;
    const periodType =
      periodTypeParam === LeaderboardPeriodType.WEEKLY ||
      periodTypeParam === LeaderboardPeriodType.MONTHLY
        ? (periodTypeParam as LeaderboardPeriodType)
        : undefined;
    const items = await this.winners.listPast({
      examType,
      periodType,
      periodStart: periodStartParam,
    });
    // listPast already takes(200); we expose a paginated envelope so the
    // admin's existing Paginated<Winner> type doesn't break, but there's
    // no real cursor pagination yet — `nextCursor: null` is honest.
    return { items, total: items.length, nextCursor: null };
  }

  @Get('hall-of-fame')
  @ApiOperation({
    summary: 'All-time top 20 by win count (default WASSCE).',
  })
  hallOfFame(@Query('examType') examTypeParam?: string) {
    const examType =
      examTypeParam &&
      Object.values(ExamType).includes(examTypeParam as ExamType)
        ? (examTypeParam as ExamType)
        : ExamType.WASSCE;
    return this.winners.allTimeHallOfFame(examType);
  }

  /**
   * Every (exam_type, period_type, period_start) tuple that has
   * leaderboard entries but NO winners selected yet. Used by the
   * admin /admin/winners page to render the full pending list —
   * not just last week. So "I forgot to pick winners three weeks
   * ago" is still actionable.
   */
  @Get('pending-periods')
  @ApiOperation({
    summary:
      'List every period (current + past) that still needs winner selection.',
  })
  pendingPeriods(
    @Query('limit') limit?: string,
    @Query('examType') examTypeParam?: string,
    @Query('periodType') periodTypeParam?: string,
  ) {
    const examType =
      examTypeParam &&
      Object.values(ExamType).includes(examTypeParam as ExamType)
        ? (examTypeParam as ExamType)
        : undefined;
    const periodType =
      periodTypeParam === (LeaderboardPeriodType.MONTHLY as string)
        ? LeaderboardPeriodType.MONTHLY
        : periodTypeParam === (LeaderboardPeriodType.WEEKLY as string)
          ? LeaderboardPeriodType.WEEKLY
          : undefined;
    return this.winners.listPendingPeriods({
      limit: limit ? parseInt(limit, 10) : 50,
      examType,
      periodType,
    });
  }

  @Get('candidates')
  @ApiOperation({
    summary:
      'Top candidate pool for the given period, annotated with anti-cheat / ' +
      'verification signals so the admin can vet before confirming.',
  })
  candidates(
    @Query('examType') examTypeParam: string,
    @Query('periodType') periodTypeParam: string,
    @Query('periodStart') periodStart: string,
  ) {
    const examType = Object.values(ExamType).includes(examTypeParam as ExamType)
      ? (examTypeParam as ExamType)
      : ExamType.WASSCE;
    // Compare against the enum value (string) rather than the enum
    // member to avoid an unsafe-enum-comparison lint — `periodTypeParam`
    // is the raw query-string type.
    const periodType =
      periodTypeParam === (LeaderboardPeriodType.MONTHLY as string)
        ? LeaderboardPeriodType.MONTHLY
        : LeaderboardPeriodType.WEEKLY;
    return this.winners.listCandidates({ examType, periodType, periodStart });
  }

  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Confirm the candidate pool and commit winner rows + XP prizes. ' +
      'Idempotent — refuses to re-run for a period that already has winners. ' +
      '`excludeUserIds` removes manually-vetoed candidates before anti-cheat.',
  })
  confirm(
    @Body()
    dto: {
      examType: ExamType;
      periodType: LeaderboardPeriodType;
      periodStart: string;
      excludeUserIds?: string[];
    },
  ) {
    return this.winners.selectWinners(dto);
  }
}
