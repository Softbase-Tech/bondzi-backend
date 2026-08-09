import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
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
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import {
  AccountType,
  EntitlementService,
  UserRole,
} from '../../common/types/enums';
import { EntitlementsService } from './entitlements.service';
import { UpdateTierServiceDto } from './dto/update-tier-service.dto';

/**
 * Admin surface for the tier × service matrix. Read the full
 * matrix, edit one cell, or inspect a user's usage snapshot for
 * today. This is the ONLY place the matrix is authored — the
 * guard reads it, callers don't set caps inline.
 */
@ApiTags('admin-entitlements')
@ApiExcludeController()
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('admin/entitlements')
export class AdminEntitlementsController {
  constructor(private readonly entitlements: EntitlementsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Full tier × service matrix. Sorted by (accountType, service) for a stable admin table.',
  })
  list() {
    return this.entitlements.listMatrix();
  }

  @Patch(':tier/:service')
  @ApiOperation({
    summary:
      'Update one cell. Fields are independently optional; unlimitedCap=true stores NULL cap.',
  })
  async update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('tier') tierParam: string,
    @Param('service') serviceParam: string,
    @Body() dto: UpdateTierServiceDto,
  ) {
    const tier = parseAccountType(tierParam);
    const service = parseService(serviceParam);
    const patch: Parameters<EntitlementsService['updatePolicy']>[3] = {};
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;
    if (dto.unlimitedCap === true) patch.dailyCap = null;
    else if (dto.dailyCap !== undefined) patch.dailyCap = dto.dailyCap;
    if (dto.config !== undefined) patch.config = dto.config;
    return this.entitlements.updatePolicy(admin.id, tier, service, patch);
  }

  @Get('usage/:userId')
  @ApiOperation({
    summary:
      'Today\'s usage snapshot for one user across every service — the ops "why did they get 429" screen.',
  })
  usage(@Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.entitlements.usageForUserToday(userId);
  }
}

function parseAccountType(v: string): AccountType {
  if ((Object.values(AccountType) as string[]).includes(v)) {
    return v as AccountType;
  }
  throw new BadRequestException(`Unknown tier: ${v}`);
}

function parseService(v: string): EntitlementService {
  if ((Object.values(EntitlementService) as string[]).includes(v)) {
    return v as EntitlementService;
  }
  throw new NotFoundException(`Unknown service: ${v}`);
}
