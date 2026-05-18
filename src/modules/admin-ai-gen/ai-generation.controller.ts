import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Sse,
  UseGuards,
  type MessageEvent,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExcludeController,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Observable } from 'rxjs';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { AiJobStatus, UserRole } from '../../common/types/enums';
import { AiGenerationJob } from './entities/ai-generation-job.entity';
import { AdminExplanationsService } from './admin-explanations.service';
import { AdminPmTestService } from '../pm-test/admin-pm-test.service';
import {
  ExplanationGenerateDto,
  ExplanationPreviewDto,
} from './dto/explanation-generate.dto';
import {
  PmTestGenerateDto,
  PmTestPreviewDto,
} from '../pm-test/dto/pm-test-generate.dto';

/**
 * Unified façade for the "AI Generation" admin page.
 *
 * The admin UX presents one screen that lets an admin generate
 * explanations OR PM Test questions and observes both job types in
 * one history list. The backend keeps the underlying logic split
 * across AdminExplanationsService and AdminPmTestService (different
 * domains, different prompts, different review flows), but exposing
 * two URL trees forces the admin UI to know which one to call.
 *
 * This controller is the single URL surface the admin talks to. Each
 * route is a thin delegate; no business logic lives here.
 *
 * Routes:
 *   GET    /admin/ai-generation/jobs                   list all jobs
 *   GET    /admin/ai-generation/jobs/:id               job detail
 *   GET    /admin/ai-generation/jobs/:id/stream        SSE progress
 *   POST   /admin/ai-generation/explanations/preview   → explanations.preview
 *   POST   /admin/ai-generation/explanations           → explanations.generate
 *   POST   /admin/ai-generation/explanations/:id       → explanations.regenerate
 *   POST   /admin/ai-generation/pm-test/preview        → pm-test.preview
 *   POST   /admin/ai-generation/pm-test                → pm-test.generate
 */
@ApiTags('admin-ai-generation')
@ApiExcludeController()
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
// Same controller-wide throttle as the per-type controllers — a
// compromised admin can otherwise burn through the AI daily budget
// by scripting the preview/generate path.
@Throttle({ default: { limit: 20, ttl: 60_000 } })
@Controller('admin/ai-generation')
export class AiGenerationController {
  constructor(
    @InjectRepository(AiGenerationJob)
    private readonly jobsRepo: Repository<AiGenerationJob>,
    private readonly explanations: AdminExplanationsService,
    private readonly pmTest: AdminPmTestService,
  ) {}

  // ============================================================
  // Combined jobs view
  // ============================================================

  @Get('jobs')
  @ApiOperation({
    summary:
      'Most recent AI generation jobs across both types (explanations + PM Test).',
  })
  listJobs(@Query('limit') limit?: string): Promise<AiGenerationJob[]> {
    // Clamp limit to [1, 200]. The history panel asks for 10 by default;
    // 200 is a generous upper bound that still bounds memory.
    const safe = Math.min(Math.max(parseInt(limit ?? '50', 10) || 50, 1), 200);
    return this.jobsRepo.find({
      order: { createdAt: 'DESC' },
      take: safe,
    });
  }

  @Get('jobs/:id')
  async job(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AiGenerationJob> {
    const job = await this.jobsRepo.findOne({ where: { id } });
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }

  @Sse('jobs/:id/stream')
  @ApiOperation({
    summary:
      'SSE progress stream. Job-type-agnostic — emits the same shape regardless of explanation vs PM Test.',
  })
  stream(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Observable<MessageEvent> {
    return this.genericStream(id);
  }

  // ============================================================
  // Explanations — delegate to AdminExplanationsService
  // ============================================================

  @Post('explanations/preview')
  @HttpCode(HttpStatus.OK)
  explanationsPreview(@Body() dto: ExplanationPreviewDto) {
    return this.explanations.preview(dto);
  }

  @Post('explanations')
  @HttpCode(HttpStatus.CREATED)
  explanationsGenerate(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: ExplanationGenerateDto,
  ) {
    return this.explanations.generate(admin.id, dto);
  }

  @Post('explanations/:id')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Single-question regenerate. Body may include { model: "claude-haiku" | "claude-sonnet" }.',
  })
  explanationsRegenerate(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: { model?: 'claude-haiku' | 'claude-sonnet' } = {},
  ) {
    const choice =
      body.model === 'claude-haiku' ? 'claude-haiku' : 'claude-sonnet';
    return this.explanations.regenerate(admin.id, id, choice);
  }

  // ============================================================
  // PM Test — delegate to AdminPmTestService
  // ============================================================

  @Post('pm-test/preview')
  @HttpCode(HttpStatus.OK)
  pmTestPreview(@Body() dto: PmTestPreviewDto) {
    return this.pmTest.preview(dto);
  }

  @Post('pm-test')
  @HttpCode(HttpStatus.CREATED)
  pmTestGenerate(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: PmTestGenerateDto,
  ) {
    return this.pmTest.generate(admin.id, dto);
  }

  // ============================================================
  // Internal — SSE polling loop (type-agnostic)
  // ============================================================

  /**
   * Polls the ai_generation_jobs row every 2s and emits the same
   * payload shape used by AdminExplanationsService.streamProgress.
   * Works for any job type because the columns
   * (status / total_items / completed_items / failed_items /
   * actual_cost_usd) are identical for explanation_bulk and
   * pm_test_generation.
   */
  private genericStream(id: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let closed = false;
      const tick = async (): Promise<void> => {
        if (closed) return;
        try {
          const job = await this.jobsRepo.findOne({ where: { id } });
          if (!job) {
            subscriber.error(new NotFoundException('Job not found'));
            closed = true;
            return;
          }
          const total = job.totalItems ?? 0;
          const processed = job.completedItems ?? 0;
          const failed = job.failedItems ?? 0;
          const remaining = Math.max(0, total - processed - failed);
          subscriber.next({
            data: {
              id: job.id,
              status: job.status,
              processed,
              failed,
              total,
              costSoFarUsd: job.actualCostUsd,
              etaSeconds: job.status === AiJobStatus.RUNNING ? remaining : null,
            },
          } as MessageEvent);
          if (
            job.status !== AiJobStatus.PENDING &&
            job.status !== AiJobStatus.PENDING_APPROVAL &&
            job.status !== AiJobStatus.RUNNING
          ) {
            subscriber.complete();
            closed = true;
          }
        } catch (err) {
          subscriber.error(err);
          closed = true;
        }
      };
      void tick();
      const timer = setInterval(() => {
        void tick();
      }, 2000);
      return () => {
        closed = true;
        clearInterval(timer);
      };
    });
  }
}
