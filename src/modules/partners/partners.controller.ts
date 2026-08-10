import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CreateReferralCodeDto } from './dto/create-referral-code.dto';
import { RegisterPartnerDto } from './dto/register-partner.dto';
import { UpdatePartnerMomoDto } from './dto/update-partner-momo.dto';
import { Partner } from './entities/partner.entity';
import { PartnerReferralCode } from './entities/partner-referral-code.entity';
import { SubmitAppealDto } from './dto/submit-appeal.dto';
import { PartnerAppealsService } from './partner-appeals.service';
import { PartnerAuthGuard } from './partner-auth.guard';
import { PartnerBannersService } from './partner-banners.service';
import { CurrentPartner } from './partner-current.decorator';
import { PartnerPayoutsService } from './partner-payouts.service';
import { PartnerTermsService } from './partner-terms.service';
import { PartnersService } from './partners.service';

/**
 * Partner-facing controller — routes served on the future
 * partners.bondzi.online subdomain. All routes require an
 * authenticated user (JwtAuthGuard); everything except the
 * register endpoint and the public terms fetch also requires an
 * approved-or-pending partner row (PartnerAuthGuard).
 *
 * Split into logical sections rather than one giant file:
 *   - register / me / momo   (self-service partner lifecycle)
 *   - codes                  (list / create / deactivate / reactivate)
 *   - terms                  (current version, for the agreement UI)
 */
@ApiTags('partners')
@Controller('partner')
export class PartnersController {
  constructor(
    private readonly partners: PartnersService,
    private readonly terms: PartnerTermsService,
    private readonly payouts: PartnerPayoutsService,
    private readonly appeals: PartnerAppealsService,
    private readonly banners: PartnerBannersService,
  ) {}

  // --------------------------------------------------------------------
  // Register / me
  // --------------------------------------------------------------------

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('register')
  @ApiOperation({
    summary: 'Register the signed-in user as a partner. Idempotent per user.',
  })
  register(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterPartnerDto,
  ) {
    return this.partners.register(user.id, dto);
  }

  @UseGuards(JwtAuthGuard, PartnerAuthGuard)
  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'Return the signed-in partner profile.' })
  me(@CurrentPartner() partner: Partner) {
    return partner;
  }

  @UseGuards(JwtAuthGuard, PartnerAuthGuard)
  @ApiBearerAuth()
  @Patch('me/momo')
  @ApiOperation({ summary: 'Update the partner MoMo payout details.' })
  updateMomo(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdatePartnerMomoDto,
  ) {
    return this.partners.updateMomo(user.id, dto);
  }

  // --------------------------------------------------------------------
  // Codes
  // --------------------------------------------------------------------

  @UseGuards(JwtAuthGuard, PartnerAuthGuard)
  @ApiBearerAuth()
  @Get('codes')
  @ApiOperation({
    summary: 'List the referral codes owned by the signed-in partner.',
  })
  @ApiOkResponse({ type: [PartnerReferralCode] })
  listCodes(@CurrentPartner() partner: Partner) {
    return this.partners.listCodes(partner.id);
  }

  @UseGuards(JwtAuthGuard, PartnerAuthGuard)
  @ApiBearerAuth()
  @Post('codes')
  @ApiOperation({ summary: 'Create a new referral code.' })
  createCode(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateReferralCodeDto,
  ) {
    return this.partners.createCode(user.id, dto);
  }

  @UseGuards(JwtAuthGuard, PartnerAuthGuard)
  @ApiBearerAuth()
  @Patch('codes/:id/deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Deactivate a non-default code. Existing attributions still resolve.',
  })
  deactivateCode(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.partners.setCodeActive(user.id, id, false);
  }

  @UseGuards(JwtAuthGuard, PartnerAuthGuard)
  @ApiBearerAuth()
  @Patch('codes/:id/reactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reactivate a previously-deactivated code.' })
  reactivateCode(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.partners.setCodeActive(user.id, id, true);
  }

  // --------------------------------------------------------------------
  // Payouts (partner-facing reads)
  // --------------------------------------------------------------------

  @UseGuards(JwtAuthGuard, PartnerAuthGuard)
  @ApiBearerAuth()
  @Get('payouts')
  @ApiOperation({
    summary: 'List the signed-in partner`s payout history (paid + pending).',
  })
  listPayouts(@CurrentPartner() partner: Partner) {
    return this.payouts.listForPartner(partner.id);
  }

  @UseGuards(JwtAuthGuard, PartnerAuthGuard)
  @ApiBearerAuth()
  @Get('payouts/preview')
  @ApiOperation({
    summary:
      'Preview the total that would be paid out RIGHT NOW (approved-and-unpaid).',
  })
  previewNextPayout(@CurrentPartner() partner: Partner) {
    return this.payouts.previewNextPayout(partner.id);
  }

  @UseGuards(JwtAuthGuard, PartnerAuthGuard)
  @ApiBearerAuth()
  @Get('payouts/:id/invoice.pdf')
  @ApiOperation({
    summary: 'Download the invoice PDF for one of your payouts.',
  })
  async downloadInvoice(
    @CurrentPartner() partner: Partner,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res() res: Response,
  ): Promise<void> {
    // Ownership check: the payout must belong to the requesting
    // partner. Anything else 400s (deliberately opaque — refusing to
    // 404 keeps the "yes/no this row exists" signal off unauth users).
    const list = await this.payouts.listForPartner(partner.id);
    const mine = list.find((p) => p.id === id);
    if (!mine) {
      throw new BadRequestException('Invoice not available for this account.');
    }
    const { filename, buffer } = await this.payouts.buildInvoicePdf(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  // --------------------------------------------------------------------
  // Appeals (partner-facing)
  // --------------------------------------------------------------------

  @UseGuards(JwtAuthGuard, PartnerAuthGuard)
  @ApiBearerAuth()
  @Get('appeals')
  @ApiOperation({ summary: 'List the signed-in partner`s appeals.' })
  listAppeals(@CurrentPartner() partner: Partner) {
    return this.appeals.listForPartner(partner.id);
  }

  @UseGuards(JwtAuthGuard, PartnerAuthGuard)
  @ApiBearerAuth()
  @Post('appeals')
  @ApiOperation({
    summary:
      'Open an appeal. Only allowed when your account is currently suspended.',
  })
  submitAppeal(
    @CurrentPartner() partner: Partner,
    @Body() dto: SubmitAppealDto,
  ) {
    return this.appeals.submitAppeal({
      partnerId: partner.id,
      body: dto.body,
      attachments: dto.attachments,
    });
  }

  // --------------------------------------------------------------------
  // Banner gallery (partner-facing read)
  // --------------------------------------------------------------------

  @UseGuards(JwtAuthGuard, PartnerAuthGuard)
  @ApiBearerAuth()
  @Get('banners')
  @ApiOperation({
    summary: 'List the active banner catalogue — images the partner can share.',
  })
  listBanners() {
    return this.banners.listActive();
  }

  // --------------------------------------------------------------------
  // Terms
  // --------------------------------------------------------------------

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Get('terms/current')
  @ApiOperation({ summary: 'The commission-terms version in force today.' })
  currentTerms() {
    return this.terms.getCurrent();
  }
}
