import {
  Body,
  Controller,
  Get,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/types/enums';
import { ReferralsService } from './referrals.service';

/**
 * Admin-facing referral analytics endpoints — called by /admin/referrals.
 * Mounted under /admin/referrals (the global prefix adds /api/v1 on top).
 */
@ApiTags('admin-referrals')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('admin/referrals')
export class AdminReferralsController {
  constructor(private readonly referrals: ReferralsService) {}

  @Get('metrics')
  @ApiOperation({ summary: 'Top-level referral funnel metrics + 30-day chart.' })
  metrics() {
    return this.referrals.adminMetrics();
  }

  @Get('top')
  @ApiOperation({ summary: 'Top referrers ordered by total referrals.' })
  top(@Query('limit') limit?: string) {
    const n = limit ? Math.min(200, Math.max(1, parseInt(limit, 10))) : 50;
    return this.referrals.adminTopReferrers(n);
  }

  @Get('chain')
  @ApiOperation({
    summary:
      'Lookup referral chain by referral code or user name (support tool).',
  })
  chain(@Query('q') q: string) {
    return this.referrals.adminChain(q ?? '');
  }

  @Get('share-template')
  @ApiOperation({
    summary: 'Current pre-filled WhatsApp share message template.',
  })
  getShareTemplate() {
    return this.referrals.getShareTemplate();
  }

  @Patch('share-template')
  @ApiOperation({
    summary: 'Update the share message template. Use {code} as placeholder.',
  })
  setShareTemplate(@Body() body: { template: string }) {
    return this.referrals.setShareTemplate(body?.template ?? '');
  }
}
