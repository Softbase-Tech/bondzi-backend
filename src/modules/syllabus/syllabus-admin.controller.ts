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
  ) {}

  @Post('ingest')
  @ApiExcludeEndpoint()
  ingest(@Body() dto: IngestSyllabusDto) {
    return this.ingestion.ingestBatch(dto.subjectId, dto.subStrands, {
      curriculumVersion: dto.curriculumVersion,
    });
  }

  @Get('indicators')
  @ApiExcludeEndpoint()
  listIndicators(@Query() q: ListIndicatorsQueryDto) {
    return this.review.list({
      subjectId: q.subjectId,
      status: q.status,
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
    return this.embedding.embedApproved();
  }
}
