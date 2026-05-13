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
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.subs.getMine(user.id);
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
    return this.subs.initiate(user.id, dto.planId, dto.interval);
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
  cancel(@CurrentUser() user: AuthenticatedUser) {
    return this.subs.cancel(user.id);
  }
}
