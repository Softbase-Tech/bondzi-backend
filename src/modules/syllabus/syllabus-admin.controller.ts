import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/types/enums';
import { SyllabusIngestionService } from './syllabus-ingestion.service';
import { IngestSyllabusDto } from './dto/ingest-syllabus.dto';

/**
 * Admin ingest of the offline pdfplumber extraction. The loader posts one
 * subject's `out/<subject>.json` array here; each sub-strand is validated and
 * upserted into the hierarchy as `draft` for review.
 */
@ApiTags('syllabus')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('admin/syllabus')
export class SyllabusAdminController {
  constructor(private readonly ingestion: SyllabusIngestionService) {}

  @Post('ingest')
  @ApiExcludeEndpoint()
  ingest(@Body() dto: IngestSyllabusDto) {
    return this.ingestion.ingestBatch(dto.subjectId, dto.subStrands, {
      curriculumVersion: dto.curriculumVersion,
    });
  }
}
