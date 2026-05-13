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
} from './dto/create-subject.dto';

@ApiTags('subjects')
@Controller('subjects')
export class SubjectsController {
  constructor(private readonly subjects: SubjectsService) {}

  @Public()
  @Get()
  @ApiOperation({
    summary:
      'List active subjects with counts. Optional ?examType=bece|wassce.',
  })
  list(@Query('examType') examType?: string) {
    const normalised =
      examType === ExamType.BECE
        ? ExamType.BECE
        : examType === ExamType.WASSCE
          ? ExamType.WASSCE
          : undefined;
    return this.subjects.listActive(normalised);
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
}
