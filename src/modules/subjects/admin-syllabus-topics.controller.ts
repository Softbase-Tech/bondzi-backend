import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExcludeController,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/types/enums';
import { SyllabusTopicsService } from './syllabus-topics.service';
import {
  BulkSyllabusTopicDto,
  CreateSyllabusTopicDto,
  RetitleFromMaterialsDto,
  UpdateSyllabusTopicDto,
} from './dto/syllabus-topic.dto';

/**
 * Admin authoring surface for the syllabus-topics catalogue. Feeds
 * PM-Test AI generation (`syllabus_topic_id` gets stamped on every
 * generated `pm_test_questions` row) and, once Phase 1.3 lands,
 * the mobile Level-Test setup screen's by-syllabus-topic picker.
 *
 * Bulk import is idempotent — re-pasting a spreadsheet refreshes
 * description / sortOrder instead of duplicating rows.
 */
@ApiTags('admin-syllabus-topics')
@ApiExcludeController()
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('admin/syllabus-topics')
export class AdminSyllabusTopicsController {
  constructor(private readonly service: SyllabusTopicsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create one syllabus topic.' })
  create(@Body() dto: CreateSyllabusTopicDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Update one syllabus topic. isActive=false soft-deletes; pass isActive=true to un-delete.',
  })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSyllabusTopicDto,
  ) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Soft-delete a syllabus topic (isActive=false). Historical linkage on pm_test_questions preserved.',
  })
  async softDelete(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.service.softDelete(id);
  }

  @Post('retitle-from-materials')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Retitle a subject's bridged topics from the textbook section titles of their linked learning-material chunks. Retitled topics are marked custom so the syllabus sync never reverts them.",
  })
  retitleFromMaterials(@Body() dto: RetitleFromMaterialsDto) {
    return this.service.retitleFromMaterials(dto.subjectId);
  }

  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Bulk-import an array of topics. Idempotent: re-importing the same rows refreshes description/sortOrder without duplicating. Returns { submitted, inserted, updated, rejected[] }.',
  })
  bulk(@Body() dto: BulkSyllabusTopicDto) {
    return this.service.bulkImport(dto.items);
  }
}
