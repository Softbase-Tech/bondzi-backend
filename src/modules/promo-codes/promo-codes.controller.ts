import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
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
import {
  CreatePromoCodeDto,
  UpdatePromoCodeDto,
} from './dto/promo-code.dto';
import { PromoCodesService } from './promo-codes.service';

/**
 * Admin CRUD for promo / discount codes. Listing + create + update +
 * delete only — the public redemption surface (`quote(code, plan, user)`)
 * is consumed by the subscriptions checkout, not exposed here directly.
 */
@ApiTags('admin-promo-codes')
@ApiExcludeController()
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('admin/promo-codes')
export class PromoCodesController {
  constructor(private readonly codes: PromoCodesService) {}

  @Get()
  @ApiOperation({ summary: 'List all promo codes (latest first).' })
  list() {
    return this.codes.list();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch a single promo code by id.' })
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.codes.getById(id);
  }

  @Post()
  @ApiOperation({
    summary:
      'Create a promo code. Code is stored lowercased — case-insensitive at redemption.',
  })
  create(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: CreatePromoCodeDto,
  ) {
    return this.codes.create(admin.id, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Update a promo code. Code string + discount type + scope are immutable — to change those, create a new code.',
  })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdatePromoCodeDto,
  ) {
    return this.codes.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Hard-delete a code. Past redemptions stay in promo_redemptions (FK is RESTRICT — codes with redemptions cannot be deleted; deactivate instead).',
  })
  remove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.codes.delete(id);
  }
}
