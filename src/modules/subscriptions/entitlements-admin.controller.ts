import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExcludeController,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../../common/types/enums';
import { EntitlementsAdminService } from './entitlements-admin.service';
import {
  GrantEntitlementDto,
  RevokeEntitlementDto,
} from './dto/entitlement-admin.dto';

/**
 * Admin entitlement surface — covers everything a support agent needs
 * to do for a paying user that isn't a self-service flow:
 *
 *   - View all (user × level) entitlements at a glance.
 *   - Manually grant Plus or Pro (e.g. for influencers, beta testers,
 *     refund-compensation goodwill).
 *   - Manually revoke an entitlement (e.g. abuse, accidental free
 *     month, refund processed out-of-band).
 *   - View the audit trail of who did what.
 *
 * Every state-changing call writes a row to the existing `audit_log`
 * table (entity_type='subscription'). No new audit table — see
 * EntitlementsAdminService for why we reuse the generic log instead of
 * a dedicated entitlement_audit table.
 */
@ApiTags('admin-entitlements')
@ApiExcludeController()
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('admin/entitlements')
export class EntitlementsAdminController {
  constructor(private readonly service: EntitlementsAdminService) {}

  @Get('user/:userId')
  @ApiOperation({
    summary:
      "Read a user's current entitlement per level (BECE / WASSCE / NOVDEC).",
  })
  forUser(@Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.service.entitlementsForUser(userId);
  }

  @Get('user/:userId/audit')
  @ApiOperation({
    summary:
      "Audit trail for one user's entitlement changes — grants, revokes, refunds.",
  })
  audit(@Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.service.auditForUser(userId);
  }

  @Post('grant')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Manually grant Plus or Pro to a user on a specific level. Plus is lifetime; Pro needs an expires_at. Always written with provider=manual so it never collides with a Paystack-driven row.',
  })
  grant(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: GrantEntitlementDto,
  ) {
    return this.service.grant(admin.id, dto);
  }

  @Post('revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Manually revoke (CANCELLED) an active entitlement. Use refund=true to flip to REFUNDED instead — that bypasses Paystack and is only for when the refund was already processed out-of-band.',
  })
  revoke(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: RevokeEntitlementDto,
  ) {
    return this.service.revoke(admin.id, dto);
  }
}
