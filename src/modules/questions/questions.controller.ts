import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/types/enums';
import { QuestionsService } from './questions.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { QuestionQueryDto } from './dto/question-query.dto';
import { AdaptiveQueryDto, PastPaperQueryDto } from './dto/past-paper.dto';
import {
  BulkImportDto,
  CreateQuestionDto,
  UpdateQuestionDto,
} from './dto/create-question.dto';
import { FlagQuestionDto } from './dto/flag-question.dto';

@ApiTags('questions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('questions')
export class QuestionsController {
  constructor(
    private readonly questions: QuestionsService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  private isAdmin(user: AuthenticatedUser): boolean {
    return user.role === UserRole.ADMIN || user.role === UserRole.SUPERADMIN;
  }

  @Get()
  async list(
    @Query() query: QuestionQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const isAdmin = this.isAdmin(user);
    const hasActiveSubscription =
      isAdmin || (await this.subscriptions.hasActiveSubscription(user.id));
    return this.questions.list(query, {
      isAdmin,
      hasActiveSubscription,
      defaultExamType: user.examType,
    });
  }

  @Get('search')
  // FTS is the expensive path on the questions table — GIN index helps, but
  // an abusive client can still burn CPU. Cap to 30/min per IP; normal study
  // sessions do ~5-10 searches in a sitting.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Full-text search on active questions.' })
  async search(
    @Query('q') q: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
  ) {
    const hasActiveSubscription =
      await this.subscriptions.hasActiveSubscription(user.id);
    return this.questions.search(
      q,
      { hasActiveSubscription },
      limit ? parseInt(limit, 10) : 20,
    );
  }

  @Get('years')
  years(@Query('subjectId', new ParseUUIDPipe()) subjectId: string) {
    return this.questions.years(subjectId);
  }

  @Get('past-paper')
  @ApiOperation({
    summary: 'All questions for a subject+year (+optional paper). Cached 24h.',
  })
  async pastPaper(
    @Query() query: PastPaperQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const hasActiveSubscription =
      await this.subscriptions.hasActiveSubscription(user.id);
    const examType = user.examType ?? 'wassce';
    return this.questions.getPastPaper(query, {
      hasActiveSubscription,
      examType,
    });
  }

  @Get('adaptive')
  @ApiOperation({
    summary: 'Adaptive question set based on SRS + weak topics.',
  })
  async adaptive(
    @Query() query: AdaptiveQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const hasActiveSubscription =
      await this.subscriptions.hasActiveSubscription(user.id);
    return this.questions.getAdaptive(user.id, query, {
      hasActiveSubscription,
    });
  }

  @Get(':id')
  async getOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const isAdmin = this.isAdmin(user);
    const hasActiveSubscription =
      isAdmin || (await this.subscriptions.hasActiveSubscription(user.id));
    return this.questions.getById(id, { isAdmin, hasActiveSubscription });
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
  @Post()
  @ApiExcludeEndpoint()
  create(@Body() dto: CreateQuestionDto) {
    return this.questions.create(dto);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
  @Patch(':id')
  @ApiExcludeEndpoint()
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateQuestionDto,
  ) {
    return this.questions.update(id, dto);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
  @Post('bulk-import')
  @ApiExcludeEndpoint()
  bulkImport(@Body() dto: BulkImportDto) {
    return this.questions.bulkImport(dto);
  }

  @Post(':id/flag')
  flag(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: FlagQuestionDto,
  ) {
    return this.questions.flag(user.id, id, dto);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
  @Post(':id/verify')
  @ApiExcludeEndpoint()
  verify(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.questions.verify(id);
  }
}
