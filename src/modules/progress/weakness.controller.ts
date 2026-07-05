import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { WeaknessBySourceResponse, WeaknessService } from './weakness.service';

class WeaknessQueryDto {
  @IsOptional()
  @IsUUID('4')
  subjectId?: string;
}

/**
 * Per-source weakness for the mobile setup screens. Two lists in one response
 * so the client makes one call regardless of which entry (past papers vs
 * level tests) it's about to render.
 */
@ApiTags('progress')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('progress')
export class WeaknessController {
  constructor(private readonly weaknessService: WeaknessService) {}

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
}
