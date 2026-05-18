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
  Sse,
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
import { ExamType, UserRole } from '../../common/types/enums';
import { AdminExplanationsService } from './admin-explanations.service';
import {
  ExplanationGenerateDto,
  ExplanationPreviewDto,
} from './dto/explanation-generate.dto';

@ApiTags('admin-explanations')
@ApiExcludeController()
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
// Controller-wide throttle. A compromised admin account (or a curious
// admin) can otherwise burn through AI_DAILY_BUDGET_USD by scripting
// the preview/generate/regenerate endpoints. 20/min covers normal admin
// work (preview → generate → poll) with headroom; the per-job cost cap
// (see AdminExplanationsService.assertUnderMaxCost + the new actualCost
// abort in the worker) is the load-bearing defense.
@Throttle({ default: { limit: 20, ttl: 60_000 } })
@Controller('admin/explanations')
export class AdminExplanationsController {
  constructor(private readonly service: AdminExplanationsService) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Dry-run estimate + confirmation token (10 min TTL). No generation triggered.',
  })
  preview(@Body() dto: ExplanationPreviewDto) {
    return this.service.preview(dto);
  }

  @Post('generate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Confirm with the preview token to enqueue the bulk-explanation job.',
  })
  generate(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: ExplanationGenerateDto,
  ) {
    return this.service.generate(admin.id, dto);
  }

  @Get('jobs')
  listJobs() {
    return this.service.listJobs();
  }

  // ============================================================
  // Co-sign endpoints (high-cost gate, AI_COSIGN_THRESHOLD_USD)
  // ============================================================

  @Get('pending-approval')
  @ApiOperation({
    summary:
      'List jobs awaiting a second admin sign-off (cost > AI_COSIGN_THRESHOLD_USD).',
  })
  listPendingApproval() {
    return this.service.listPendingApproval();
  }

  @Post('jobs/:id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Approve a high-cost AI job (must be a DIFFERENT admin than the creator).',
  })
  approveCosign(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.approveCosign(admin.id, id);
  }

  @Post('jobs/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a pending-approval AI job.' })
  rejectCosign(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: { reason?: string } = {},
  ) {
    return this.service.rejectCosign(admin.id, id, body.reason);
  }

  @Get('calibration')
  @ApiOperation({
    summary:
      'Actual P50/P95 input/output tokens per (model, action) over the last N days. Used to recalibrate TOKEN_ESTIMATES in estimates.util.ts.',
  })
  calibration(@Query('days') days?: string) {
    const n = days ? parseInt(days, 10) : 7;
    const safe = Number.isFinite(n) && n > 0 ? Math.min(n, 90) : 7;
    return this.service.calibrationReport(safe);
  }

  @Sse('jobs/:id/stream')
  @ApiOperation({ summary: 'SSE progress stream (spec §5.1).' })
  stream(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.streamProgress(id);
  }

  @Get('jobs/:id')
  @ApiOperation({ summary: 'One-shot job status snapshot.' })
  job(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.getJob(id);
  }

  @Get('pending')
  @ApiOperation({
    summary: 'Paginated list of active questions that have no explanation.',
  })
  pending(
    @Query('examType') examType?: ExamType,
    @Query('subjectId') subjectId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listPending({
      examType,
      subjectId,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Post('regenerate/:questionId')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Regenerate a single question explanation. Overwrites on success.',
  })
  regenerate(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('questionId', new ParseUUIDPipe()) questionId: string,
    @Query('model') model?: string,
  ) {
    const choice = model === 'claude-haiku' ? 'claude-haiku' : 'claude-sonnet';
    return this.service.regenerate(admin.id, questionId, choice);
  }
}
