import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
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
import { WinnerSelectionService } from './winner-selection.service';
import { SelectWinnersDto } from './dto/select-winners.dto';

@ApiTags('admin-leaderboard')
@ApiExcludeController()
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('admin/leaderboard')
export class AdminLeaderboardController {
  constructor(private readonly winners: WinnerSelectionService) {}

  @Post('select-winners')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Admin-triggered winner selection for a just-ended period. Idempotent: refuses re-runs.',
  })
  select(@Body() dto: SelectWinnersDto) {
    return this.winners.selectWinners(dto);
  }
}
