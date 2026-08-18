import {
  Body,
  Controller,
  Delete,
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
  ApiExcludeController,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/types/enums';
import { AdminPmTestService } from './admin-pm-test.service';
import {
  PmTestGenerateDto,
  PmTestPreviewDto,
  PmTestReviewBulkDto,
} from './dto/pm-test-generate.dto';

@ApiTags('admin-pm-test')
@ApiExcludeController()
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
// See AdminExplanationsController for the rationale — same cost-cap
// rationale applies to PM Test bulk generation.
@Throttle({ default: { limit: 20, ttl: 60_000 } })
@Controller('admin/pm-test')
export class AdminPmTestController {
  constructor(private readonly service: AdminPmTestService) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Dry-run estimate + confirmation token (10 min TTL). No generation triggered.',
  })
  preview(@Body() dto: PmTestPreviewDto) {
    return this.service.preview(dto);
  }

  @Post('generate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Confirm with the preview token to enqueue the generation job. Returns job record.',
  })
  generate(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: PmTestGenerateDto,
  ) {
    return this.service.generate(admin.id, dto);
  }

  // Spec §4.3 names this confirm path explicitly. Same handler.
  @Post('generate/confirm')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Alias of POST /admin/pm-test/generate (spec §4.3 path).',
  })
  generateConfirm(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: PmTestGenerateDto,
  ) {
    return this.service.generate(admin.id, dto);
  }

  @Get('jobs')
  @ApiOperation({
    summary: 'List up to 100 most recent PM Test generation jobs.',
  })
  listJobs() {
    return this.service.listJobs();
  }

  @Get('jobs/:id')
  job(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.getJob(id);
  }

  @Get('list')
  @ApiOperation({
    summary:
      'Paginated browse of the pm_test_questions bank across all statuses. Powers the Level Test (AI) source on /admin/questions.',
  })
  list(
    @Query('examType') examType?: string,
    @Query('formLevel') formLevel?: string,
    @Query('subjectId') subjectId?: string,
    @Query('difficulty') difficulty?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listAll({
      examType,
      formLevel: formLevel ? parseInt(formLevel, 10) : undefined,
      subjectId,
      difficulty,
      status,
      search,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('review')
  @ApiOperation({
    summary:
      'Paginated pending_review questions. Filters by exam/form/subject.',
  })
  review(
    @Query('examType') examType?: string,
    @Query('formLevel') formLevel?: string,
    @Query('subjectId') subjectId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listReview({
      examType,
      formLevel: formLevel ? parseInt(formLevel, 10) : undefined,
      subjectId,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Patch('review/bulk')
  @ApiOperation({ summary: 'Bulk approve / reject / edit staged questions.' })
  bulk(@Body() dto: PmTestReviewBulkDto) {
    return this.service.bulkReview(dto);
  }

  @Post('publish/:id')
  publish(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.publish(id);
  }

  @Delete(':id')
  archive(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.archive(id);
  }
}
