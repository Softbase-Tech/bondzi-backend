import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AchievementsService } from './achievements.service';

/**
 * User-facing achievements. One endpoint: the merged view (catalogue
 * + per-user progress + evaluated unlock state) that powers the
 * Milestones strip on the mobile Profile screen.
 */
@ApiTags('achievements')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users/me/achievements')
export class AchievementsController {
  constructor(private readonly svc: AchievementsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Every active achievement with the caller’s progress + unlock state.',
  })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.svc.listForUser(user.id);
  }
}
