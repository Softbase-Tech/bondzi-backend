import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../../common/types/enums';
import { AchievementsService } from './achievements.service';
import {
  CreateAchievementDto,
  UpsertAchievementDto,
} from './dto/upsert-achievement.dto';

/**
 * Admin CRUD for the achievements catalogue. Retiring an achievement
 * flips `is_active=false` — we deliberately never hard-delete a row
 * so per-user unlock history isn't orphaned.
 */
@ApiTags('admin-achievements')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('admin/achievements')
export class AchievementsAdminController {
  constructor(private readonly svc: AchievementsService) {}

  @Get()
  @ApiOperation({
    summary: 'List every achievement, active and retired, in sort order.',
  })
  list() {
    return this.svc.listAllForAdmin();
  }

  @Post()
  @ApiOperation({ summary: 'Create a new achievement.' })
  create(@Body() dto: CreateAchievementDto) {
    return this.svc.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update fields on an achievement.' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertAchievementDto,
  ) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      'Retire an achievement (soft-delete — hides from mobile, keeps per-user unlock rows).',
  })
  retire(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.retire(id);
  }
}
