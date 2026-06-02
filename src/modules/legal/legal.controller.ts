import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length } from 'class-validator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../../common/types/enums';
import { LegalService } from './legal.service';

/**
 * Public + admin surface for legal pages.
 *
 *   GET /legal/:slug           — public read (mobile fetches refund-policy / terms / privacy)
 *   GET /admin/legal           — admin list all
 *   PUT /admin/legal/:slug     — admin upsert
 *   DELETE /admin/legal/:slug  — admin delete
 *
 * Public read is intentionally NOT authenticated — refund / terms pages
 * must be reachable from the marketing site and from unauthenticated
 * checkout screens.
 */

class UpsertLegalPageDto {
  @IsString()
  @Length(2, 200)
  title!: string;

  @IsString()
  @IsNotEmpty()
  body!: string;
}

@ApiTags('legal')
@Controller()
export class LegalController {
  constructor(private readonly legal: LegalService) {}

  // ----- Public -----------------------------------------------------------

  @Public()
  @Get('legal/:slug')
  @ApiOperation({
    summary:
      'Fetch a legal page by slug (refund-policy, terms, privacy). Public — no auth required.',
  })
  publicGet(@Param('slug') slug: string) {
    return this.legal.getBySlug(slug);
  }

  // ----- Admin ------------------------------------------------------------

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
  @ApiBearerAuth()
  @Get('admin/legal')
  @ApiOperation({ summary: 'List all legal pages.' })
  list() {
    return this.legal.list();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
  @ApiBearerAuth()
  @Put('admin/legal/:slug')
  @ApiOperation({
    summary:
      'Create or update a legal page. Body is Markdown — rendered as-is by the mobile client.',
  })
  upsert(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('slug') slug: string,
    @Body() dto: UpsertLegalPageDto,
  ) {
    return this.legal.upsert({
      slug,
      title: dto.title,
      body: dto.body,
      updatedBy: admin.id,
    });
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
  @ApiBearerAuth()
  @Delete('admin/legal/:slug')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Remove a legal page. The seeded `refund-policy` slug should NOT be deleted — the mobile checkout flow links to it.',
  })
  remove(@Param('slug') slug: string) {
    return this.legal.delete(slug);
  }
}
