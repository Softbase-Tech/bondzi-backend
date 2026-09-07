import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/types/enums';
import {
  IngestChunkDto,
  LearningMaterialService,
} from './learning-material.service';
import type { LearningMaterialChunkType } from './entities/learning-material-chunk.entity';

class IngestChunkBodyDto implements IngestChunkDto {
  @IsInt()
  @Min(1)
  @Max(3)
  formLevel!: number;

  @IsOptional()
  @IsString()
  strandCode?: string | null;

  @IsOptional()
  @IsString()
  subStrandCode?: string | null;

  @IsOptional()
  @IsString()
  sectionCode?: string | null;

  @IsString()
  @IsNotEmpty()
  sectionTitle!: string;

  @IsIn(['key_ideas', 'introduction', 'example', 'activity', 'content'])
  chunkType!: LearningMaterialChunkType;

  @IsString()
  @IsNotEmpty()
  bodyMd!: string;

  @IsString()
  @IsNotEmpty()
  sourcePdf!: string;

  @IsOptional()
  @IsInt()
  sourcePage?: number | null;
}

class IngestLearningMaterialDto {
  @IsUUID()
  subjectId!: string;

  @IsOptional()
  @IsBoolean()
  replace?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => IngestChunkBodyDto)
  chunks!: IngestChunkBodyDto[];
}

class UpdateChunkBodyDto {
  @IsString()
  @IsNotEmpty()
  bodyMd!: string;
}

/**
 * Admin surface for the Knowledge Layer (premium plan §4): ingest from
 * the offline extractor, the spot-check reviewer (list + edit body +
 * delete), and the per-subject coverage gauge.
 */
@ApiTags('admin-syllabus')
@ApiExcludeController()
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('admin/syllabus/learning-materials')
export class LearningMaterialAdminController {
  constructor(private readonly service: LearningMaterialService) {}

  @Post('ingest')
  ingest(@Body() dto: IngestLearningMaterialDto) {
    return this.service.ingest({
      subjectId: dto.subjectId,
      chunks: dto.chunks,
      replace: dto.replace ?? false,
    });
  }

  @Post('embed-missing')
  embedMissing(@Body() body: { subjectId?: string } = {}) {
    // Background pass over chunks with no vector yet (optionally one
    // subject). Returns immediately; watch the coverage endpoint.
    return this.service.startEmbedMissing(body?.subjectId);
  }

  @Get()
  list(
    @Query('subjectId') subjectId?: string,
    @Query('formLevel') formLevel?: string,
    @Query('chunkType') chunkType?: string,
    @Query('q') q?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
  ) {
    return this.service.list({
      subjectId,
      formLevel: formLevel != null ? Number(formLevel) : undefined,
      chunkType,
      q,
      page: Math.max(1, Number(page) || 1),
      limit: Math.min(200, Math.max(1, Number(limit) || 50)),
    });
  }

  @Get('coverage/:subjectId')
  coverage(@Param('subjectId', new ParseUUIDPipe()) subjectId: string) {
    return this.service.coverage(subjectId);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateChunkBodyDto,
  ) {
    return this.service.updateBody(id, dto.bodyMd);
  }

  @Delete(':id')
  async remove(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.service.remove(id);
    return { ok: true };
  }
}
