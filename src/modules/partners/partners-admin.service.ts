import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import {
  PartnerCommissionStatus,
  PartnerCommissionType,
  PartnerFraudSeverity,
  PartnerPayoutStatus,
  PartnerStatus,
} from '../../common/types/enums';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { MailService } from '../mail/mail.service';
import { MailEvent } from '../mail/mail.types';
import { PartnerAttribution } from './entities/partner-attribution.entity';
import { PartnerCommission } from './entities/partner-commission.entity';
import { PartnerFraudEvent } from './entities/partner-fraud-event.entity';
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
    @InjectRepository(PartnerFraudEvent)
    private readonly fraudRepo: Repository<PartnerFraudEvent>,
    private readonly mail: MailService,
    private readonly dataSource: DataSource,
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
    if (partner.status === PartnerStatus.SUSPENDED) return partner;
    partner.status = PartnerStatus.SUSPENDED;
    partner.suspendedAt = new Date();
    const saved = await this.partnersRepo.save(partner);
    this.logger.log(
      `[partners-admin.suspend] partner=${partner.id} by=${input.adminUserId} reason=${input.reason}`,
    );
    // Notify. Non-blocking.
    const portalBase = (this.mail.getWebUrl() ?? '').replace(/\/$/, '');
    void this.mail
      .send(
        MailEvent.PARTNER_ACCOUNT_SUSPENDED,
        partner.email,
        {
          recipientName: partner.fullName,
          partnerName: partner.fullName,
          reason: input.reason,
          appealsUrl: `${portalBase}/partner/appeals`,
          appealsRemaining: 3,
        },
        {
          userId: partner.userId ?? undefined,
          dedupKey: `partner_suspended:${partner.id}:${Math.floor(
            (partner.suspendedAt?.getTime() ?? 0) / 60_000,
          )}`,
        },
      )
      .catch((err) =>
        this.logger.error(
          `[partners-admin.suspend] email failed partner=${partner.id}: ${(err as Error).message}`,
        ),
      );
    return saved;
  }

  /**
   * Permanently ban a partner. Forfeits every outstanding commission
   * that hasn't landed in a PAID payout yet (paid money already left
   * — we don't chase it back). Sends the ban notice email.
   *
   * Idempotent on already-banned rows. SUSPENDED and ACTIVE both
   * flip through here.
   */
  async banPartner(input: {
    partnerId: string;
    adminUserId: string;
    reason: string;
  }): Promise<Partner> {
    const partner = await this.partnersRepo.findOne({
      where: { id: input.partnerId },
    });
    if (!partner) throw new NotFoundException('Partner not found.');
    if (partner.status === PartnerStatus.BANNED) return partner;

    await this.dataSource.transaction(async (em) => {
      partner.status = PartnerStatus.BANNED;
      partner.bannedAt = new Date();
      await em.getRepository(Partner).save(partner);
      // Forfeit outstanding earnings.
      await em
        .getRepository(PartnerCommission)
        .createQueryBuilder()
        .update()
        .set({ status: PartnerCommissionStatus.CLAWED_BACK })
        .where('partner_id = :pid', { pid: partner.id })
        .andWhere(`status IN ('pending','approved','flagged')`)
        .execute();
    });

    this.logger.warn(
      `[partners-admin.ban] partner=${partner.id} by=${input.adminUserId} reason=${input.reason}`,
    );

    void this.mail
      .send(
        MailEvent.PARTNER_ACCOUNT_BANNED,
        partner.email,
        {
          recipientName: partner.fullName,
          partnerName: partner.fullName,
          reason: input.reason,
        },
        {
          userId: partner.userId ?? undefined,
          dedupKey: `partner_banned:${partner.id}`,
        },
      )
      .catch((err) =>
        this.logger.error(
          `[partners-admin.ban] email failed partner=${partner.id}: ${(err as Error).message}`,
        ),
      );
    return partner;
  }

  // --------------------------------------------------------------------
  // Fraud events (admin queue)
  // --------------------------------------------------------------------

  async listFraudEvents(input: {
    partnerId?: string;
    severity?: PartnerFraudSeverity;
    resolved?: boolean;
    page?: number;
    limit?: number;
  }): Promise<PaginatedResult<PartnerFraudEvent>> {
    const page = input.page ?? 1;
    const limit = input.limit ?? 50;
    const qb = this.fraudRepo
      .createQueryBuilder('e')
      .orderBy('e.detected_at', 'DESC');
    if (input.partnerId)
      qb.andWhere('e.partner_id = :pid', { pid: input.partnerId });
    if (input.severity) qb.andWhere('e.severity = :sv', { sv: input.severity });
    if (typeof input.resolved === 'boolean')
      qb.andWhere('e.resolved = :r', { r: input.resolved });
    qb.take(limit).skip((page - 1) * limit);
    const [items, total] = await qb.getManyAndCount();
    return { items, total, nextCursor: null };
  }

  /**
   * Mark a fraud event resolved. Doesn't change the partner's status
   * or the flag counter — this is purely a triage marker for the ops
   * queue. Suspend / ban decisions live on `suspendPartner` /
   * `banPartner` and appeals.
   */
  async resolveFraudEvent(input: {
    fraudEventId: string;
    adminUserId: string;
    resolutionNote?: string;
  }): Promise<PartnerFraudEvent> {
    const row = await this.fraudRepo.findOne({
      where: { id: input.fraudEventId },
    });
    if (!row) throw new NotFoundException('Fraud event not found.');
    if (row.resolved) return row;
    row.resolved = true;
    row.resolvedAt = new Date();
    row.resolvedBy = input.adminUserId;
    row.resolutionNote = input.resolutionNote ?? null;
    return this.fraudRepo.save(row);
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
