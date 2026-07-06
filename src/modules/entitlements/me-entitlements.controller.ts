import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import {
  EntitlementsService,
  UserEntitlementSnapshot,
} from './entitlements.service';

/**
 * Client-facing entitlements snapshot for the mobile "X/Y today" strips
 * and lock states. Separate controller from the admin one because the
 * admin surface is roles-gated and returns cross-user data; this one
 * returns only the caller's own snapshot and needs only JWT.
 *
 * Route: GET /me/entitlements
 * Contract (see EntitlementsService.snapshotForUser):
 *   {
 *     accountType: 'free' | 'plus' | 'pro',
 *     examType:    'bece' | 'wassce' | 'novdec' | null,
 *     services: [
 *       { service, enabled, dailyCap, used, remaining }
 *     ]
 *   }
 *
 * `remaining` is null when the service is disabled OR unlimited — clients
 * should read `enabled && dailyCap === null` for "Pro unlimited" and
 * `!enabled` for "locked", and show a `used/dailyCap` counter only when
 * `remaining` is a concrete number.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me')
export class MeEntitlementsController {
  constructor(private readonly entitlements: EntitlementsService) {}

  @Get('entitlements')
  @ApiOperation({
    summary:
      "The caller's own tier + per-service quota snapshot for today. Not gated by any entitlement — the client needs this to decide whether to show upgrade CTAs.",
  })
  snapshot(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UserEntitlementSnapshot> {
    return this.entitlements.snapshotForUser(user.id);
  }
}
