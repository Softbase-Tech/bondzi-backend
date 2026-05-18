import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { XpEconomyService } from './xp-economy.service';
import { RedeemDto } from './dto/redeem.dto';

@ApiTags('xp')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('xp')
export class XpEconomyController {
  constructor(private readonly xp: XpEconomyService) {}

  @Get()
  @ApiOperation({
    summary:
      'Current XP snapshot + active earn rates + redemption tiers (single call).',
  })
  summary(@CurrentUser() user: AuthenticatedUser) {
    return this.xp.summary(user.id);
  }

  @Get('tiers')
  @ApiOperation({ summary: 'Active redemption tiers (admin-editable).' })
  tiers() {
    return this.xp.listTiers();
  }

  @Get('rates')
  @ApiOperation({ summary: 'Active XP earn rates (admin-editable).' })
  rates() {
    return this.xp.listRates();
  }

  @Get('history')
  @ApiOperation({ summary: 'Recent XP transactions (default 50, max 200).' })
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
  ) {
    // Bound the limit on BOTH ends: a negative or NaN value silently
    // turning into MIN_SAFE_INTEGER would make the underlying query
    // either empty or scan the full table; an unbounded high value
    // (?limit=999999) lets a caller load every XP transaction in
    // memory in one shot. The historical spec is 50 default / 200 max.
    const parsed = limit ? parseInt(limit, 10) : 50;
    const safe = Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
    return this.xp.history(user.id, Math.min(safe, 200));
  }

  @Post('redeem')
  // Redemption must be a deliberate, confirmed action; a race-condition or
  // double-tap could debit twice despite the server-side DB transaction.
  // Cap to 5/min per user/IP — a student redeems maybe once a month.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Spend spendable XP for a subscription credit — extends an active sub if present.',
  })
  redeem(@CurrentUser() user: AuthenticatedUser, @Body() dto: RedeemDto) {
    return this.xp.redeem(user.id, dto.tierKey);
  }
}
