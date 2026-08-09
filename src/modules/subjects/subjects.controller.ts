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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { ExamType, UserRole } from '../../common/types/enums';
import { Public } from '../../common/decorators/public.decorator';
import { SubjectsService } from './subjects.service';
import {
  CreateSubjectDto,
  CreateTopicDto,
  UpdateSubjectDto,
  UpdateTopicDto,
} from './dto/create-subject.dto';

@ApiTags('subjects')
@Controller('subjects')
export class SubjectsController {
  constructor(private readonly subjects: SubjectsService) {}

  @Public()
  @Get()
  @ApiOperation({
    summary:
      'List subjects with counts. Optional ?examType=bece|wassce. ' +
      'Admins can pass ?includeInactive=true to see disabled rows in the admin management page.',
  })
  list(
    @Query('examType') examType?: string,
    @Query('includeInactive') includeInactiveRaw?: string,
  ) {
    // NOVDEC students share the WASSCE question pool — they study the
    // same syllabus and sit the same exam at a different sitting. There
    // are no separate NOVDEC subject rows, so we remap to WASSCE on the
    // way in. Without this, a NOVDEC user's home screen would show zero
    // subjects (the exam_type filter is exact-match).
    const normalised =
      examType === ExamType.BECE
        ? ExamType.BECE
        : examType === ExamType.WASSCE || examType === ExamType.NOVDEC
          ? ExamType.WASSCE
          : undefined;
    // Treat "true"/"1" as opt-in; everything else (and absent) =
    // active-only. We don't gate this query param behind a guard —
    // listing disabled subjects is harmless to non-admins, and
    // putting an authz wall here would require splitting the public
    // and admin controllers without any real security gain.
    const includeInactive =
      includeInactiveRaw === 'true' || includeInactiveRaw === '1';
    return this.subjects.listActive(normalised, { includeInactive });
  }

  @Public()
  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.subjects.getById(id);
  }

  @Public()
  @Get(':id/topics')
  topics(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.subjects.getTopics(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
  @ApiBearerAuth()
  @Post()
  create(@Body() dto: CreateSubjectDto) {
    return this.subjects.create(dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
  @ApiBearerAuth()
  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSubjectDto,
  ) {
    return this.subjects.update(id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
  @ApiBearerAuth()
  @Post(':id/topics')
  createTopic(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateTopicDto,
  ) {
    return this.subjects.createTopic(id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
  @ApiBearerAuth()
  @Patch('topics/:topicId')
  @ApiOperation({ summary: 'Update topic title / description / sort order.' })
  updateTopic(
    @Param('topicId', new ParseUUIDPipe()) topicId: string,
    @Body() dto: UpdateTopicDto,
  ) {
    return this.subjects.updateTopic(topicId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
  @ApiBearerAuth()
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Soft-delete a subject. Existing questions tagged with this subject still resolve; the row is hidden from public listings.',
  })
  async remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.subjects.softDelete(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
  @ApiBearerAuth()
  @Delete('topics/:topicId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a topic.' })
  async removeTopic(
    @Param('topicId', new ParseUUIDPipe()) topicId: string,
  ): Promise<void> {
    await this.subjects.softDeleteTopic(topicId);
  }
}
