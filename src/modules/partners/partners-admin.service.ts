import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
  PartnerCommissionStatus,
  PartnerCommissionType,
  PartnerPayoutStatus,
  PartnerStatus,
} from '../../common/types/enums';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { MailService } from '../mail/mail.service';
import { MailEvent } from '../mail/mail.types';
import { PartnerAttribution } from './entities/partner-attribution.entity';
import { PartnerCommission } from './entities/partner-commission.entity';
import { PartnerPayout } from './entities/partner-payout.entity';
import { PartnerReferralCode } from './entities/partner-referral-code.entity';
import { Partner } from './entities/partner.entity';

/**
 * Aggregate view of a partner returned by `getPartnerDetail`. Wraps the
 * partner row with the derived read-only stats admin needs on the
 * profile page — total attributed users, current APPROVED-and-unpaid
 * balance, count of PAID commissions, and the default referral code.
 */
export interface PartnerDetail {
  partner: Partner;
  defaultCode: PartnerReferralCode | null;
  attributionsCount: number;
  approvedUnpaidGhs: string;
  paidCommissionCount: number;
  totalPaidGhs: string;
}

/**
 * Admin surface for the partner portal. Every method here is called
 * from a route already gated by JwtAuthGuard + RolesGuard(ADMIN,
 * SUPERADMIN) — no need to re-check.
 *
 * Scope split from PartnersService:
 *   - PartnersService owns partner + code CRUD, only ever called by
 *     the partner themselves.
 *   - PartnersAdminService owns lifecycle transitions admins drive
 *     (approve, suspend) + ledger reads across all partners.
 */
@Injectable()
export class PartnersAdminService {
  private readonly logger = new Logger(PartnersAdminService.name);

  constructor(
    @InjectRepository(Partner)
    private readonly partnersRepo: Repository<Partner>,
    @InjectRepository(PartnerReferralCode)
    private readonly codesRepo: Repository<PartnerReferralCode>,
    @InjectRepository(PartnerAttribution)
    private readonly attributionsRepo: Repository<PartnerAttribution>,
    @InjectRepository(PartnerCommission)
    private readonly commissionsRepo: Repository<PartnerCommission>,
    @InjectRepository(PartnerPayout)
    private readonly payoutsRepo: Repository<PartnerPayout>,
    private readonly mail: MailService,
  ) {}

  // --------------------------------------------------------------------
  // Partners
  // --------------------------------------------------------------------

  async listPartners(input: {
    status?: PartnerStatus;
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<PaginatedResult<Partner>> {
    const page = input.page ?? 1;
    const limit = input.limit ?? 20;
    const qb = this.partnersRepo
      .createQueryBuilder('p')
      .orderBy('p.created_at', 'DESC');
    if (input.status) qb.andWhere('p.status = :st', { st: input.status });
    if (input.search) {
      const like = `%${input.search.toLowerCase()}%`;
      qb.andWhere(
        `(lower(p.email) LIKE :like OR lower(p.full_name) LIKE :like OR p.phone LIKE :like)`,
        { like },
      );
    }
    qb.take(limit).skip((page - 1) * limit);
    const [items, total] = await qb.getManyAndCount();
    return { items, total, nextCursor: null };
  }

  async getPartnerDetail(partnerId: string): Promise<PartnerDetail> {
    const partner = await this.partnersRepo.findOne({
      where: { id: partnerId },
    });
    if (!partner) throw new NotFoundException('Partner not found.');

    const [defaultCode, attributionsCount, approvedRows, paidRows] =
      await Promise.all([
        this.codesRepo.findOne({
          where: { partnerId, isDefault: true },
        }),
        this.attributionsRepo.count({ where: { partnerId } }),
        this.commissionsRepo.find({
          where: {
            partnerId,
            status: PartnerCommissionStatus.APPROVED,
            paidOutId: IsNull(),
          },
          select: ['id', 'amountGhs'],
        }),
        this.commissionsRepo.find({
          where: { partnerId, status: PartnerCommissionStatus.PAID },
          select: ['id', 'amountGhs'],
        }),
      ]);

    const approvedUnpaid = approvedRows.reduce(
      (s, r) => s + Number(r.amountGhs),
      0,
    );
    const totalPaid = paidRows.reduce((s, r) => s + Number(r.amountGhs), 0);

    return {
      partner,
      defaultCode,
      attributionsCount,
      approvedUnpaidGhs: approvedUnpaid.toFixed(2),
      paidCommissionCount: paidRows.length,
      totalPaidGhs: totalPaid.toFixed(2),
    };
  }

  async approvePartner(input: {
    partnerId: string;
    adminUserId: string;
  }): Promise<Partner> {
    const partner = await this.partnersRepo.findOne({
      where: { id: input.partnerId },
    });
    if (!partner) throw new NotFoundException('Partner not found.');
    if (partner.status === PartnerStatus.ACTIVE) return partner;
    if (partner.status !== PartnerStatus.PENDING) {
      throw new BadRequestException(
        `Only PENDING partners can be approved. This one is ${partner.status}.`,
      );
    }
    partner.status = PartnerStatus.ACTIVE;
    partner.approvedAt = new Date();
    partner.approvedBy = input.adminUserId;
    // Any commissions that had been sitting in PENDING (partner was
    // still under review) become APPROVED so they enter the next
    // payout window. FLAGGED commissions do NOT auto-flip — admin has
    // to resolve those individually.
    await this.commissionsRepo
      .createQueryBuilder()
      .update()
      .set({ status: PartnerCommissionStatus.APPROVED })
      .where('partner_id = :pid', { pid: partner.id })
      .andWhere('status = :st', { st: PartnerCommissionStatus.PENDING })
      .execute();
    const saved = await this.partnersRepo.save(partner);

    // Approval email with default code + dashboard link. Best-effort.
    const defaultCode = await this.codesRepo.findOne({
      where: { partnerId: partner.id, isDefault: true },
    });
    const portalUrl = `${this.mail.getWebUrl().replace(/\/$/, '')}/partner`;
    void this.mail
      .send(
        MailEvent.PARTNER_APPROVED,
        partner.email,
        {
          recipientName: partner.fullName,
          partnerName: partner.fullName,
          defaultCode: defaultCode?.code ?? 'YOUR-CODE',
          portalUrl,
        },
        {
          userId: partner.userId ?? undefined,
          dedupKey: `partner_approved:${partner.id}`,
        },
      )
      .catch((err) =>
        this.logger.error(
          `[partners-admin.approve] email dispatch failed partner=${partner.id}: ${(err as Error).message}`,
        ),
      );
    return saved;
  }

  async suspendPartner(input: {
    partnerId: string;
    adminUserId: string;
    reason: string;
  }): Promise<Partner> {
    const partner = await this.partnersRepo.findOne({
      where: { id: input.partnerId },
    });
    if (!partner) throw new NotFoundException('Partner not found.');
    if (partner.status === PartnerStatus.BANNED) {
      throw new BadRequestException('Cannot suspend a banned partner.');
    }
    partner.status = PartnerStatus.SUSPENDED;
    partner.suspendedAt = new Date();
    const saved = await this.partnersRepo.save(partner);
    this.logger.log(
      `[partners-admin.suspend] partner=${partner.id} by=${input.adminUserId} reason=${input.reason}`,
    );
    return saved;
  }

  // --------------------------------------------------------------------
  // Commissions
  // --------------------------------------------------------------------

  async listCommissions(input: {
    partnerId?: string;
    status?: PartnerCommissionStatus;
    type?: PartnerCommissionType;
    page?: number;
    limit?: number;
  }): Promise<PaginatedResult<PartnerCommission>> {
    const page = input.page ?? 1;
    const limit = input.limit ?? 50;
    const qb = this.commissionsRepo
      .createQueryBuilder('c')
      .orderBy('c.earned_at', 'DESC');
    if (input.partnerId)
      qb.andWhere('c.partner_id = :pid', { pid: input.partnerId });
    if (input.status) qb.andWhere('c.status = :st', { st: input.status });
    if (input.type) qb.andWhere('c.type = :tp', { tp: input.type });
    qb.take(limit).skip((page - 1) * limit);
    const [items, total] = await qb.getManyAndCount();
    return { items, total, nextCursor: null };
  }

  /**
   * Resolve a FLAGGED commission by either approving it (partner
   * really did earn it despite the fraud flag) or clawing it back
   * (fraud confirmed). Only FLAGGED commissions can be resolved via
   * this method — pending/approved/paid go through their normal
   * lifecycle.
   */
  async resolveFlaggedCommission(input: {
    commissionId: string;
    adminUserId: string;
    decision: 'approve' | 'clawback';
    note?: string;
  }): Promise<PartnerCommission> {
    const c = await this.commissionsRepo.findOne({
      where: { id: input.commissionId },
    });
    if (!c) throw new NotFoundException('Commission not found.');
    if (c.status !== PartnerCommissionStatus.FLAGGED) {
      throw new BadRequestException(
        `Only FLAGGED commissions can be resolved. This one is ${c.status}.`,
      );
    }
    c.status =
      input.decision === 'approve'
        ? PartnerCommissionStatus.APPROVED
        : PartnerCommissionStatus.CLAWED_BACK;
    c.eligibilityMeta = {
      ...(c.eligibilityMeta ?? {}),
      resolvedBy: input.adminUserId,
      resolvedAt: new Date().toISOString(),
      resolveNote: input.note ?? null,
      resolveDecision: input.decision,
    };
    return this.commissionsRepo.save(c);
  }

  // --------------------------------------------------------------------
  // Payouts (thin reads; write flow lives in PartnerPayoutsService)
  // --------------------------------------------------------------------

  async listPayouts(input: {
    partnerId?: string;
    status?: PartnerPayoutStatus;
    page?: number;
    limit?: number;
  }): Promise<PaginatedResult<PartnerPayout>> {
    const page = input.page ?? 1;
    const limit = input.limit ?? 50;
    const qb = this.payoutsRepo
      .createQueryBuilder('p')
      .orderBy('p.created_at', 'DESC');
    if (input.partnerId)
      qb.andWhere('p.partner_id = :pid', { pid: input.partnerId });
    if (input.status) qb.andWhere('p.status = :st', { st: input.status });
    qb.take(limit).skip((page - 1) * limit);
    const [items, total] = await qb.getManyAndCount();
    return { items, total, nextCursor: null };
  }

  async getPayoutDetail(payoutId: string): Promise<{
    payout: PartnerPayout;
    partner: Partner;
    commissions: PartnerCommission[];
  }> {
    const payout = await this.payoutsRepo.findOne({ where: { id: payoutId } });
    if (!payout) throw new NotFoundException('Payout not found.');
    const [partner, commissions] = await Promise.all([
      this.partnersRepo.findOne({ where: { id: payout.partnerId } }),
      this.commissionsRepo.find({
        where: { paidOutId: payout.id },
        order: { earnedAt: 'ASC' },
      }),
    ]);
    if (!partner) throw new NotFoundException('Partner not found.');
    return { payout, partner, commissions };
  }
}
