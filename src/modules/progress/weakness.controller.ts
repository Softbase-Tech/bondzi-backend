import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { WeaknessBySourceResponse, WeaknessService } from './weakness.service';
import {
  WeaknessNarrativeResponse,
  WeaknessNarrativeService,
} from './weakness-narrative.service';

class WeaknessQueryDto {
  @IsOptional()
  @IsUUID('4')
  subjectId?: string;
}

/**
 * Per-source weakness for the mobile setup screens. Two lists in one response
 * so the client makes one call regardless of which entry (past papers vs
 * level tests) it's about to render.
 *
 * `/weakness/narrative` generates a personalised prose narrative from
 * the same rollups. It's gated by AI_WEAKNESS_NARRATIVES inside the
 * service (Free=disabled, Plus=1/day, Pro=unlimited), consumed only on
 * cache-miss so repeat GETs in the same day cost nothing.
 */
@ApiTags('progress')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('progress')
export class WeaknessController {
  constructor(
    private readonly weaknessService: WeaknessService,
    private readonly narrativeService: WeaknessNarrativeService,
  ) {}

  @Get('weakness')
  @ApiOperation({
    summary:
      'Weakest topics per source (past-paper topics + syllabus topics), optionally scoped to one subject.',
  })
  weakness(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: WeaknessQueryDto,
  ): Promise<WeaknessBySourceResponse> {
    return this.weaknessService.forUser(user.id, {
      subjectId: query.subjectId,
    });
  }

  @Get('weakness/narrative')
  @ApiOperation({
    summary:
      "AI-generated prose narrative of the caller's weakness rollup. Same-day, same-scope requests return the cached narrative without consuming another AI_WEAKNESS_NARRATIVES quota point.",
  })
  narrative(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: WeaknessQueryDto,
  ): Promise<WeaknessNarrativeResponse> {
    return this.narrativeService.forUser(user.id, {
      subjectId: query.subjectId,
    });
  }
}
