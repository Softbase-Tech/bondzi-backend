import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { ReferralsService } from './referrals.service';

@ApiTags('referrals')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('referrals')
export class ReferralsController {
  constructor(private readonly referrals: ReferralsService) {}

  @Get('me')
  @ApiOperation({
    summary: 'Referral code + referred/qualified counts for current user.',
  })
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.referrals.statsForUser(user.id);
  }

  @Get('events')
  @ApiOperation({
    summary: 'List of people the current user has referred (up to 50).',
  })
  events(@CurrentUser() user: AuthenticatedUser) {
    return this.referrals.listEvents(user.id);
  }
}
