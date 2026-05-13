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
