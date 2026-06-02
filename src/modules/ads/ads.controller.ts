import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
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
import { UserRole } from '../../common/types/enums';
import { AdsService } from './ads.service';
import { UpdateAdConfigDto } from './dto/update-ad-config.dto';

@ApiTags('ads')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class AdsController {
  constructor(private readonly ads: AdsService) {}

  // ---- Student-facing --------------------------------------------------

  @Get('ads/config')
  @ApiOperation({
    summary: 'Client ad config. Subscribed users always get adsEnabled=false.',
  })
  clientConfig(@CurrentUser() user: AuthenticatedUser) {
    return this.ads.getClientConfig(user.id, user.examType);
  }

  @Post('ads/rewarded-complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Called after a rewarded ad completes. Awards XP (capped daily).',
  })
  rewardedComplete(@CurrentUser() user: AuthenticatedUser) {
    return this.ads.awardRewarded(user.id, user.examType);
  }

  // ---- Admin -----------------------------------------------------------

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
  @Get('admin/ads/config')
  @ApiExcludeEndpoint()
  adminConfig() {
    return this.ads.getAdminConfig();
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
  @Patch('admin/ads/config')
  @ApiExcludeEndpoint()
  updateAdminConfig(@Body() dto: UpdateAdConfigDto) {
    return this.ads.updateAdminConfig(dto);
  }
}
