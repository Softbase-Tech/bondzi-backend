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
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/types/enums';
import { SyllabusIngestionService } from './syllabus-ingestion.service';
import { SyllabusReviewService } from './syllabus-review.service';
import { SyllabusEmbeddingService } from './syllabus-embedding.service';
import { SyllabusTopicSyncService } from '../subjects/syllabus-topic-sync.service';
import { IngestSyllabusDto } from './dto/ingest-syllabus.dto';
import {
  ApproveAllDto,
  ListIndicatorsQueryDto,
  UpdateIndicatorDto,
} from './dto/review-syllabus.dto';

/**
 * Admin surface for the curriculum spine:
 *   POST   /admin/syllabus/ingest            load extracted sub-strands (draft)
 *   GET    /admin/syllabus/indicators        review queue (filter by subject/status)
 *   PATCH  /admin/syllabus/indicators/:id    edit / approve an indicator
 *   POST   /admin/syllabus/approve-all       bulk-approve drafts (optional subject)
 *   GET    /admin/syllabus/summary           per-subject draft/approved coverage
 *   POST   /admin/syllabus/embed             embed approved indicators (pgvector)
 */
@ApiTags('syllabus')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('admin/syllabus')
export class SyllabusAdminController {
  constructor(
    private readonly ingestion: SyllabusIngestionService,
    private readonly review: SyllabusReviewService,
    private readonly embedding: SyllabusEmbeddingService,
    private readonly topicSync: SyllabusTopicSyncService,
  ) {}

  @Post('ingest')
  @ApiExcludeEndpoint()
  async ingest(@Body() dto: IngestSyllabusDto) {
    const result = await this.ingestion.ingestBatch(
      dto.subjectId,
      dto.subStrands,
      { curriculumVersion: dto.curriculumVersion },
    );
    // Bridge every newly-landed content standard into
    // `syllabus_topics` so the mobile Level Test picker sees it. Kept
    // out of `SyllabusIngestionService` per extraction brief §10 —
    // this is additive plumbing composed at the controller layer.
    const sync = await this.topicSync.syncAll({ subjectId: dto.subjectId });
    return { ...result, topicSync: sync };
  }

  @Post('sync-topics')
  @ApiExcludeEndpoint()
  syncTopics(@Body() body: { subjectId?: string } = {}) {
    return this.topicSync.syncAll({ subjectId: body?.subjectId });
  }

  @Get('indicators')
  @ApiExcludeEndpoint()
  listIndicators(@Query() q: ListIndicatorsQueryDto) {
    return this.review.list({
      subjectId: q.subjectId,
      status: q.status,
      embedded: q.embedded,
      page: q.page ?? 1,
      limit: q.limit ?? 50,
    });
  }

  @Patch('indicators/:id')
  @ApiExcludeEndpoint()
  updateIndicator(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateIndicatorDto,
  ) {
    return this.review.update(id, dto);
  }

  @Post('approve-all')
  @ApiExcludeEndpoint()
  approveAll(@Body() dto: ApproveAllDto) {
    return this.review.approveAll({ subjectId: dto.subjectId });
  }

  @Get('summary')
  @ApiExcludeEndpoint()
  summary() {
    return this.review.summary();
  }

  @Post('embed')
  @ApiExcludeEndpoint()
  embed() {
    // Returns immediately; the embed pass runs in the background (it can take
    // minutes and would otherwise blow the gateway timeout).
    return this.embedding.startEmbedApproved();
  }
}
