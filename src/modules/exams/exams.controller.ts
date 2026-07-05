import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { ExamsService } from './exams.service';
import { CreateExamDto, SubmitAnswerDto } from './dto/create-exam.dto';
import { HistoryQueryDto } from './dto/history-query.dto';

@ApiTags('exams')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('exams')
export class ExamsController {
  constructor(private readonly exams: ExamsService) {}

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateExamDto) {
    return this.exams.create(user.id, dto);
  }

  @Get('history')
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: HistoryQueryDto,
  ) {
    return this.exams.history(user.id, query);
  }

  @Get('resume')
  @ApiOperation({
    summary:
      'Most-recent in-progress exam (or null) — powers home "Continue where you left off".',
  })
  resume(@CurrentUser() user: AuthenticatedUser) {
    return this.exams.resumeMostRecent(user.id);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.exams.getOne(user.id, id);
  }

  @Post(':id/answers')
  // XP-farming ceiling: even at peak study, a human answers ~1 question/sec.
  // 120/min leaves headroom for offline-queue flushes on reconnect without
  // letting a scripted client farm XP.
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'Submit one answer. See spec §5.5.' })
  submitAnswer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SubmitAnswerDto,
  ) {
    return this.exams.submitAnswer(user.id, id, dto);
  }

  @Post(':id/complete')
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.exams.complete(user.id, id);
  }

  @Post(':id/abandon')
  @HttpCode(HttpStatus.NO_CONTENT)
  async abandon(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    await this.exams.abandon(user.id, id);
  }

  @Get(':id/result')
  result(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.exams.getResult(user.id, id);
  }

  @Post(':id/breakdown')
  @ApiOperation({
    summary:
      'AI-generated post-exam breakdown. Currently dormant — POST_EXAM_AI_BREAKDOWN is disabled on every tier in the seed, so this returns 403 until an admin flips it on. Once enabled, same-exam repeat calls return the cached breakdown without consuming another quota point.',
  })
  breakdown(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.exams.generateBreakdown(user.id, id);
  }
}
