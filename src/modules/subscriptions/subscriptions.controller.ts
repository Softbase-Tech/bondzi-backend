import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { SubscriptionsService } from './subscriptions.service';
import {
  InitiateSubscriptionDto,
  VerifySubscriptionDto,
} from './dto/initiate.dto';

@ApiTags('subscriptions')
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subs: SubscriptionsService) {}

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({
    summary:
      "Returns the user's subscription on their current level (from JWT). Pass the user's examType so cross-level holdings don't leak — a Plus on WASSCE shouldn't surface as the 'current' sub when the user is on NOVDEC.",
  })
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.subs.getMine(user.id, user.examType ?? null);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Get('entitlements')
  @ApiOperation({
    summary:
      'Resolved entitlement on each level (BECE / WASSCE / NOVDEC). Mobile uses this to paint per-level "Current plan" state on the plans screen.',
  })
  entitlements(@CurrentUser() user: AuthenticatedUser) {
    return this.subs.entitlementsForAllLevels(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('initiate')
  @ApiOperation({
    summary:
      'Start a checkout session for the given plan + cadence. Returns the authorizationUrl the client should open.',
  })
  initiate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InitiateSubscriptionDto,
  ) {
    // `interval` is undefined for one-time (Plus) plans. The service
    // validates the combination against the plan's `payment_kind` and
    // returns 400 if a Pro plan was selected without an interval or a
    // Plus plan was selected with one. `promoCode` is optional; the
    // service yields 400 with a precise reason if supplied but invalid.
    return this.subs.initiate(user.id, dto.planId, dto.interval ?? null, {
      promoCode: dto.promoCode,
    });
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('verify')
  @ApiOperation({
    summary: 'Server-side verify after checkout callback.',
  })
  verify(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: VerifySubscriptionDto,
  ) {
    return this.subs.verify(user.id, dto.reference);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Cancels the user's active subscription on their CURRENT level (from JWT). A Plus on WASSCE is not affected when a NOVDEC Pro is cancelled.",
  })
  cancel(@CurrentUser() user: AuthenticatedUser) {
    return this.subs.cancel(user.id, user.examType ?? null);
  }
}
