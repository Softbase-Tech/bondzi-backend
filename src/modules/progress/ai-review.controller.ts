import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/types/enums';
import { AiReviewService } from './ai-review.service';
import { AiReviewConfigService } from './ai-review-config.service';
import {
  AiReviewHistoryQueryDto,
  GenerateAiReviewDto,
} from './dto/ai-review.dto';
import { UpdateAiReviewConfigDto } from './dto/update-ai-review-config.dto';

@ApiTags('ai-reviews')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class AiReviewController {
  constructor(
    private readonly reviews: AiReviewService,
    private readonly reviewConfig: AiReviewConfigService,
  ) {}

  // ---- Student-facing --------------------------------------------------

  @Post('progress/ai-reviews')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Generate a new AI Study Review. Consumes one monthly unit (Plus/Pro only). 403 when Free or out of allowance.',
  })
  generate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: GenerateAiReviewDto,
  ) {
    return this.reviews.generate(user.id, user.examType, {
      subjectId: dto.subjectId,
    });
  }

  @Get('progress/ai-reviews')
  @ApiOperation({
    summary: 'Paginated history of the caller’s AI reviews, newest first.',
  })
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AiReviewHistoryQueryDto,
  ) {
    return this.reviews.history(user.id, {
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
  }

  @Get('progress/ai-reviews/quota')
  @ApiOperation({
    summary:
      'Monthly AI-review allowance + the latest review, for the Home card. Declared before :id so "quota" is not read as an id.',
  })
  quota(@CurrentUser() user: AuthenticatedUser) {
    return this.reviews.quota(user.id, user.examType);
  }

  @Get('progress/ai-reviews/:id')
  @ApiOperation({
    summary: 'Full markdown of one AI review owned by the caller.',
  })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.reviews.findOne(user.id, id);
  }

  // ---- Admin -----------------------------------------------------------

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
  @Get('admin/config/ai-reviews')
  @ApiExcludeEndpoint()
  adminConfig() {
    return this.reviewConfig.get();
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
  @Patch('admin/config/ai-reviews')
  @ApiExcludeEndpoint()
  updateAdminConfig(@Body() dto: UpdateAiReviewConfigDto) {
    return this.reviewConfig.update(dto);
  }
}
