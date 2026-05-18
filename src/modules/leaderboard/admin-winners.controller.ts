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
  ): Promise<{ items: Winner[]; total: number; nextCursor: string | null }> {
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
