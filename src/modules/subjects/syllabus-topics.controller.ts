import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { SyllabusTopicsService } from './syllabus-topics.service';
import { ListSyllabusTopicsQueryDto } from './dto/syllabus-topic.dto';

/**
 * Consumer read — used by:
 *   - admin PM-Test generation picker
 *     (components/admin/ai-generation/pm-test-panel.tsx)
 *   - mobile Level-Test setup screen (Phase 1.3 will consume this)
 *
 * JWT-required. Every filter is optional; the picker calls with all
 * three (examType + subjectId + formLevel) to narrow to the exact
 * subject/form the operator is generating for.
 */
@ApiTags('syllabus-topics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('syllabus-topics')
export class SyllabusTopicsController {
  constructor(private readonly service: SyllabusTopicsService) {}

  @Get()
  @ApiOperation({
    summary:
      'List active syllabus topics. Filter by examType, subjectId, formLevel.',
  })
  list(@Query() query: ListSyllabusTopicsQueryDto) {
    return this.service.list({
      examType: query.examType,
      subjectId: query.subjectId,
      formLevel: query.formLevel,
    });
  }
}
