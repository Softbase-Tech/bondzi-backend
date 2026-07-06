import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExcludeController,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/types/enums';
import { RejectLogService } from './reject-log.service';

class RejectLogQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  @IsOptional()
  reason?: string;

  @IsOptional()
  @IsIn(['bedrock', 'ollama'])
  provider?: 'bedrock' | 'ollama';

  @IsOptional()
  model?: string;
}

/**
 * Admin reject-log browser. Exposes the raw log (30-day retention) and
 * the indefinite weekly aggregate. Used by the ops team to answer
 * "why did the last generation batch under-perform" — the aggregate
 * shows trends across models / providers, the raw log has the exact
 * output that failed validation.
 *
 * Kept in the AI module (not admin) because the underlying service +
 * entities live here — cross-module import would force AdminModule
 * to depend on AiModule with no other reason.
 */
@ApiTags('admin')
@ApiExcludeController()
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('admin/ai/rejects')
export class AdminRejectLogController {
  constructor(private readonly rejectLog: RejectLogService) {}

  @Get()
  @ApiOperation({
    summary:
      'Paged raw reject-log with optional filters. Default 50/page, max 200.',
  })
  async listRaw(@Query() query: RejectLogQueryDto): Promise<{
    items: unknown[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const [items, total] = await this.rejectLog.listRaw({
      limit: query.limit,
      offset: query.offset,
      reason: query.reason,
      provider: query.provider,
      model: query.model,
    });
    return {
      items,
      total,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    };
  }

  @Get('agg')
  @ApiOperation({
    summary:
      'Weekly aggregate. One row per (week_start, reason, provider, model) with a running failure count. Retained indefinitely (unlike the raw log).',
  })
  listAgg() {
    return this.rejectLog.listAgg();
  }
}
