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
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  PartnerAppealStatus,
  PartnerCommissionStatus,
  PartnerCommissionType,
  PartnerFraudSeverity,
  PartnerPayoutStatus,
  PartnerStatus,
  UserRole,
} from '../../common/types/enums';
import { BanPartnerDto } from './dto/ban-partner.dto';
import { CreateTermsVersionDto } from './dto/create-terms-version.dto';
import { MarkPayoutFailedDto } from './dto/mark-payout-failed.dto';
import { MarkPayoutPaidDto } from './dto/mark-payout-paid.dto';
import { ResolveAppealDto } from './dto/resolve-appeal.dto';
import { SuspendPartnerDto } from './dto/suspend-partner.dto';
import { CreateBannerDto, UpdateBannerDto } from './dto/upsert-banner.dto';
import { PartnerAppealsService } from './partner-appeals.service';
import { PartnerBannersService } from './partner-banners.service';
import { PartnerPayoutsService } from './partner-payouts.service';
import { PartnerReferralsService } from './partner-referrals.service';
import { PartnerTermsService } from './partner-terms.service';
import { PartnersAdminService } from './partners-admin.service';

/**
 * Admin routes under `/admin/partners/*`. Gated by JwtAuthGuard +
 * RolesGuard(ADMIN, SUPERADMIN); admin panel on
 * `admin.bondzi.online` is the only client.
 */
@ApiTags('admin/partners')
@ApiExcludeController()
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('admin/partners')
export class PartnersAdminController {
  constructor(
    private readonly admin: PartnersAdminService,
    private readonly payouts: PartnerPayoutsService,
    private readonly appeals: PartnerAppealsService,
    private readonly terms: PartnerTermsService,
    private readonly banners: PartnerBannersService,
    private readonly referrals: PartnerReferralsService,
  ) {}

  // --------------------------------------------------------------------
  // Partners
  // --------------------------------------------------------------------

  @Get()
  listPartners(
    @Query() p: PaginationDto,
    @Query('status') status?: PartnerStatus,
    @Query('search') search?: string,
  ) {
    return this.admin.listPartners({
      status,
      search,
      page: p.page ?? 1,
      limit: p.limit ?? 20,
    });
  }

  @Get(':id')
  getPartner(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.admin.getPartnerDetail(id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approvePartner(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.admin.approvePartner({
      partnerId: id,
      adminUserId: user.id,
    });
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  suspendPartner(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SuspendPartnerDto,
  ) {
    return this.admin.suspendPartner({
      partnerId: id,
      adminUserId: user.id,
      reason: dto.reason,
    });
  }

  @Post(':id/ban')
  @HttpCode(HttpStatus.OK)
  banPartner(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: BanPartnerDto,
  ) {
    return this.admin.banPartner({
      partnerId: id,
      adminUserId: user.id,
      reason: dto.reason,
    });
  }

  @Get(':id/referrals')
  listPartnerReferrals(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('codeId') codeId?: string,
    @Query('sort') sort?: 'recent' | 'engaged' | 'earning',
  ) {
    return this.referrals.listForPartner({
      partnerId: id,
      codeId,
      sort,
    });
  }

  // --------------------------------------------------------------------
  // Fraud events queue
  // --------------------------------------------------------------------

  @Get('fraud-events/list')
  listFraudEvents(
    @Query() p: PaginationDto,
    @Query('partnerId') partnerId?: string,
    @Query('severity') severity?: PartnerFraudSeverity,
    @Query('resolved') resolved?: string,
  ) {
    return this.admin.listFraudEvents({
      partnerId,
      severity,
      resolved:
        resolved === 'true' ? true : resolved === 'false' ? false : undefined,
      page: p.page ?? 1,
      limit: p.limit ?? 50,
    });
  }

  @Post('fraud-events/:id/resolve')
  @HttpCode(HttpStatus.OK)
  resolveFraudEvent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body('resolutionNote') resolutionNote?: string,
  ) {
    return this.admin.resolveFraudEvent({
      fraudEventId: id,
      adminUserId: user.id,
      resolutionNote,
    });
  }

  // --------------------------------------------------------------------
  // Appeals (admin resolution)
  // --------------------------------------------------------------------

  @Get('appeals/list')
  listAppeals(
    @Query() p: PaginationDto,
    @Query('partnerId') partnerId?: string,
    @Query('status') status?: PartnerAppealStatus,
  ) {
    return this.appeals.listAll({
      partnerId,
      status,
      page: p.page ?? 1,
      limit: p.limit ?? 50,
    });
  }

  @Post('appeals/:id/resolve')
  @HttpCode(HttpStatus.OK)
  resolveAppeal(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ResolveAppealDto,
  ) {
    return this.appeals.resolveAppeal({
      appealId: id,
      adminUserId: user.id,
      decision: dto.decision,
      resolutionNote: dto.resolutionNote ?? null,
    });
  }

  // --------------------------------------------------------------------
  // Terms editor
  // --------------------------------------------------------------------

  @Get('terms/list')
  listTerms() {
    return this.terms.listAll();
  }

  @Post('terms')
  createTerms(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTermsVersionDto,
  ) {
    return this.terms.createNewVersion({
      createdBy: user.id,
      ...dto,
    });
  }

  // --------------------------------------------------------------------
  // Banner gallery
  // --------------------------------------------------------------------

  @Get('banners/list')
  listBanners() {
    return this.banners.listAll();
  }

  @Post('banners')
  createBanner(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBannerDto,
  ) {
    return this.banners.create({
      createdBy: user.id,
      ...dto,
    });
  }

  @Patch('banners/:id')
  @HttpCode(HttpStatus.OK)
  updateBanner(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateBannerDto,
  ) {
    return this.banners.update(id, dto);
  }

  @Delete('banners/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeBanner(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.banners.remove(id);
  }

  // --------------------------------------------------------------------
  // Commissions
  // --------------------------------------------------------------------

  @Get('commissions/list')
  listCommissions(
    @Query() p: PaginationDto,
    @Query('partnerId') partnerId?: string,
    @Query('status') status?: PartnerCommissionStatus,
    @Query('type') type?: PartnerCommissionType,
  ) {
    return this.admin.listCommissions({
      partnerId,
      status,
      type,
      page: p.page ?? 1,
      limit: p.limit ?? 50,
    });
  }

  @Post('commissions/:id/approve')
  @HttpCode(HttpStatus.OK)
  approveFlaggedCommission(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body('note') note?: string,
  ) {
    return this.admin.resolveFlaggedCommission({
      commissionId: id,
      adminUserId: user.id,
      decision: 'approve',
      note,
    });
  }

  @Post('commissions/:id/clawback')
  @HttpCode(HttpStatus.OK)
  clawbackFlaggedCommission(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body('note') note?: string,
  ) {
    return this.admin.resolveFlaggedCommission({
      commissionId: id,
      adminUserId: user.id,
      decision: 'clawback',
      note,
    });
  }

  // --------------------------------------------------------------------
  // Payouts
  // --------------------------------------------------------------------

  @Get(':id/payouts/preview')
  previewPayout(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.payouts.previewNextPayout(id);
  }

  @Post(':id/payouts')
  createPayout(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body('weekOf') weekOf?: string,
    @Body('notes') notes?: string,
  ) {
    return this.payouts.createPayout(id, { weekOf, notes: notes ?? null });
  }

  @Get('payouts/list')
  listPayouts(
    @Query() p: PaginationDto,
    @Query('partnerId') partnerId?: string,
    @Query('status') status?: PartnerPayoutStatus,
  ) {
    return this.admin.listPayouts({
      partnerId,
      status,
      page: p.page ?? 1,
      limit: p.limit ?? 50,
    });
  }

  @Get('payouts/:id')
  getPayout(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.admin.getPayoutDetail(id);
  }

  @Post('payouts/:id/mark-paid')
  @HttpCode(HttpStatus.OK)
  markPayoutPaid(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: MarkPayoutPaidDto,
  ) {
    return this.payouts.markPaid({
      payoutId: id,
      adminUserId: user.id,
      momoReference: dto.momoReference,
    });
  }

  @Post('payouts/:id/mark-failed')
  @HttpCode(HttpStatus.OK)
  markPayoutFailed(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: MarkPayoutFailedDto,
  ) {
    return this.payouts.markFailed({
      payoutId: id,
      adminUserId: user.id,
      reason: dto.reason,
    });
  }

  /**
   * Regenerate the invoice PDF on demand. Streams as
   * application/pdf. Kept as an admin route so ops can re-download a
   * partner's invoice without hunting through mail archives; a
   * partner-side download endpoint lives on /partner/payouts/:id/invoice.
   */
  @Get('payouts/:id/invoice.pdf')
  async downloadInvoice(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { filename, buffer } = await this.payouts.buildInvoicePdf(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }
}
