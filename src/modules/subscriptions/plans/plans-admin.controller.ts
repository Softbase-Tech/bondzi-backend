import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
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
} from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { UserRole } from '../../../common/types/enums';
import { CreatePlanDto } from './dto/create-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';
import { PlansService } from './plans.service';

@ApiTags('admin-plans')
@ApiExcludeController()
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('admin/plans')
export class PlansAdminController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  @ApiOperation({
    summary:
      'List all plans (active + archived). Pass ?country=GH to filter, ?includeInactive=false to hide archived.',
  })
  list(
    @Query('country') country?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.plans.list({
      countryCode: country,
      includeInactive: includeInactive !== 'false',
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch a single plan row.' })
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.plans.getById(id);
  }

  @Post()
  @ApiOperation({
    summary:
      'Create a plan. When syncProvider is true (default), creates the three cadence plans on the provider and stores their codes.',
  })
  create(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreatePlanDto) {
    return this.plans.create(admin.id, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Update a plan. Cosmetic changes (name/description/isActive/isDefault) patch in place. Any price or duration change inserts a NEW version row and archives the previous.',
  })
  update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdatePlanDto,
  ) {
    return this.plans.update(admin.id, id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      'Soft-delete (is_active=false). Existing subscribers keep renewing on provider; new checkouts are blocked.',
  })
  delete(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.plans.softDelete(admin.id, id);
  }

  @Post(':id/sync')
  @ApiOperation({
    summary:
      'Create any missing provider plan codes. Idempotent — does nothing if all three codes are already present.',
  })
  sync(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.plans.syncWithProvider(admin.id, id);
  }

  @Post(':id/set-default')
  @ApiOperation({
    summary:
      'Mark as the default plan for its country. Clears the flag on any other active plan in the same country.',
  })
  setDefault(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.plans.setDefault(admin.id, id);
  }

  @Post(':id/rollback')
  @ApiOperation({
    summary:
      'Reactivate an archived version. Deactivates the currently-active plan in the same country. No provider calls — old codes are preserved on the archive row.',
  })
  rollback(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.plans.rollbackTo(admin.id, id);
  }
}
