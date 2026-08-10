import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  PartnerAppealStatus,
  PartnerCommissionStatus,
  PartnerStatus,
} from '../../common/types/enums';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { MailService } from '../mail/mail.service';
import { MailEvent } from '../mail/mail.types';
import { PartnerAppeal } from './entities/partner-appeal.entity';
import { PartnerCommission } from './entities/partner-commission.entity';
import { Partner } from './entities/partner.entity';
import { PartnerTermsService } from './partner-terms.service';

/**
 * Partner appeals lifecycle.
 *
 * Rules (per plan doc §7.3):
 *   - Only SUSPENDED partners can open appeals. Active partners have
 *     nothing to appeal; banned partners are out of appeals.
 *   - Each partner gets `terms.max_appeals` shots total (default 3).
 *     appeal_number is a monotonically-increasing counter enforced by
 *     the UNIQUE(partner_id, appeal_number) index. Callers submit
 *     without picking a number — we compute it inside a transaction.
 *   - Only ONE appeal can be OPEN at a time. Second attempt while an
 *     appeal is still open → 409-equivalent.
 *   - Admin resolves each open appeal as UPHELD (partner back to
 *     ACTIVE, fraud counter reset) or DENIED (partner stays
 *     SUSPENDED; third DENIED flips to BANNED).
 */
@Injectable()
export class PartnerAppealsService {
  private readonly logger = new Logger(PartnerAppealsService.name);

  constructor(
    @InjectRepository(PartnerAppeal)
    private readonly appealsRepo: Repository<PartnerAppeal>,
    @InjectRepository(Partner)
    private readonly partnersRepo: Repository<Partner>,
    @InjectRepository(PartnerCommission)
    private readonly commissionsRepo: Repository<PartnerCommission>,
    private readonly terms: PartnerTermsService,
    private readonly mail: MailService,
    private readonly dataSource: DataSource,
  ) {}

  // --------------------------------------------------------------------
  // Submit (partner-facing)
  // --------------------------------------------------------------------

  async submitAppeal(input: {
    partnerId: string;
    body: string;
    attachments?: string[];
  }): Promise<PartnerAppeal> {
    const partner = await this.partnersRepo.findOne({
      where: { id: input.partnerId },
    });
    if (!partner) throw new NotFoundException('Partner not found.');
    if (partner.status !== PartnerStatus.SUSPENDED) {
      throw new BadRequestException(
        `Only SUSPENDED partners can open appeals — this account is ${partner.status}.`,
      );
    }

    const termsVersion = await this.terms.getCurrent();

    return this.dataSource.transaction(async (em) => {
      const appealsRepo = em.getRepository(PartnerAppeal);
      // Lock the partner's appeals rows so a double-submit race
      // can't allocate the same appeal_number twice.
      const existing = await appealsRepo
        .createQueryBuilder('a')
        .setLock('pessimistic_write')
        .where('a.partner_id = :pid', { pid: partner.id })
        .orderBy('a.appeal_number', 'DESC')
        .getMany();

      const openAppeal = existing.find(
        (a) => a.status === PartnerAppealStatus.OPEN,
      );
      if (openAppeal) {
        throw new BadRequestException(
          'You already have an open appeal — wait for it to be resolved before opening another.',
        );
      }
      if (existing.length >= termsVersion.maxAppeals) {
        throw new BadRequestException(
          `You've used your ${termsVersion.maxAppeals} appeal allocation.`,
        );
      }

      const nextNumber = existing.length + 1;
      const created = await appealsRepo.save(
        appealsRepo.create({
          partnerId: partner.id,
          appealNumber: nextNumber,
          body: input.body.trim(),
          attachments: input.attachments ?? [],
          status: PartnerAppealStatus.OPEN,
        }),
      );
      return created;
    });
  }

  // --------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------

  async listForPartner(partnerId: string): Promise<PartnerAppeal[]> {
    return this.appealsRepo.find({
      where: { partnerId },
      order: { appealNumber: 'DESC' },
    });
  }

  async listOpen(input: {
    page?: number;
    limit?: number;
  }): Promise<PaginatedResult<PartnerAppeal>> {
    const page = input.page ?? 1;
    const limit = input.limit ?? 50;
    const [items, total] = await this.appealsRepo.findAndCount({
      where: { status: PartnerAppealStatus.OPEN },
      order: { openedAt: 'ASC' },
      take: limit,
      skip: (page - 1) * limit,
    });
    return { items, total, nextCursor: null };
  }

  async listAll(input: {
    partnerId?: string;
    status?: PartnerAppealStatus;
    page?: number;
    limit?: number;
  }): Promise<PaginatedResult<PartnerAppeal>> {
    const page = input.page ?? 1;
    const limit = input.limit ?? 50;
    const qb = this.appealsRepo
      .createQueryBuilder('a')
      .orderBy('a.opened_at', 'DESC');
    if (input.partnerId)
      qb.andWhere('a.partner_id = :pid', { pid: input.partnerId });
    if (input.status) qb.andWhere('a.status = :st', { st: input.status });
    qb.take(limit).skip((page - 1) * limit);
    const [items, total] = await qb.getManyAndCount();
    return { items, total, nextCursor: null };
  }

  // --------------------------------------------------------------------
  // Resolve (admin-facing)
  // --------------------------------------------------------------------

  /**
   * Uphold or deny an open appeal.
   *
   *   uphold → partner status flips back to ACTIVE, fraud_flag_count
   *            resets to 0 (a clean slate — the offence is spent).
   *
   *   deny   → appeal is closed. If this was the partner's
   *            terms.max_appeals-th denied appeal, we flip status to
   *            BANNED and forfeit outstanding commissions (paid_out
   *            stays intact — that money already left the ledger).
   */
  async resolveAppeal(input: {
    appealId: string;
    adminUserId: string;
    decision: 'upheld' | 'denied';
    resolutionNote?: string | null;
  }): Promise<PartnerAppeal> {
    const appeal = await this.appealsRepo.findOne({
      where: { id: input.appealId },
    });
    if (!appeal) throw new NotFoundException('Appeal not found.');
    if (appeal.status !== PartnerAppealStatus.OPEN) {
      throw new BadRequestException(
        `Only OPEN appeals can be resolved. This one is ${appeal.status}.`,
      );
    }
    const partner = await this.partnersRepo.findOne({
      where: { id: appeal.partnerId },
    });
    if (!partner) throw new NotFoundException('Partner not found.');
    if (partner.status === PartnerStatus.BANNED) {
      throw new ForbiddenException(
        'Cannot resolve appeals on a banned partner.',
      );
    }

    const termsVersion = await this.terms.getCurrent();
    const now = new Date();
    let triggersBan = false;

    await this.dataSource.transaction(async (em) => {
      const appealsRepo = em.getRepository(PartnerAppeal);
      const partnersRepo = em.getRepository(Partner);
      const commissionsRepo = em.getRepository(PartnerCommission);

      appeal.status =
        input.decision === 'upheld'
          ? PartnerAppealStatus.UPHELD
          : PartnerAppealStatus.DENIED;
      appeal.resolvedAt = now;
      appeal.resolvedBy = input.adminUserId;
      appeal.resolutionNote = input.resolutionNote ?? null;
      await appealsRepo.save(appeal);

      if (input.decision === 'upheld') {
        // Reinstate. Reset the strike counter so a subsequent minor
        // flag doesn't immediately re-suspend.
        partner.status = PartnerStatus.ACTIVE;
        partner.fraudFlagCount = 0;
        partner.suspendedAt = null;
        await partnersRepo.save(partner);
      } else {
        // Denied. Count denied appeals — third one bans.
        const denied = await appealsRepo.count({
          where: {
            partnerId: partner.id,
            status: PartnerAppealStatus.DENIED,
          },
        });
        if (denied >= termsVersion.maxAppeals) {
          partner.status = PartnerStatus.BANNED;
          partner.bannedAt = now;
          await partnersRepo.save(partner);
          triggersBan = true;

          // Forfeit outstanding earnings. Anything already PAID is
          // untouched (that money is spent); everything else moves
          // to CLAWED_BACK so the ledger reflects the ban.
          await commissionsRepo
            .createQueryBuilder()
            .update()
            .set({ status: PartnerCommissionStatus.CLAWED_BACK })
            .where('partner_id = :pid', { pid: partner.id })
            .andWhere(`status IN ('pending','approved','flagged')`)
            .execute();
        }
      }
    });

    // Best-effort emails outside the transaction.
    const portalBase = (this.mail.getWebUrl() ?? '').replace(/\/$/, '');
    const appealsUrl = `${portalBase}/partner/appeals`;
    const deniedRemaining = Math.max(
      0,
      termsVersion.maxAppeals -
        (await this.appealsRepo.count({
          where: {
            partnerId: partner.id,
            status: PartnerAppealStatus.DENIED,
          },
        })),
    );
    void this.mail
      .send(
        MailEvent.PARTNER_APPEAL_RESOLVED,
        partner.email,
        {
          recipientName: partner.fullName,
          partnerName: partner.fullName,
          appealNumber: appeal.appealNumber,
          decision: input.decision,
          resolutionNote: input.resolutionNote ?? null,
          triggersBan,
          appealsRemaining: deniedRemaining,
          appealsUrl,
        },
        {
          userId: partner.userId ?? undefined,
          dedupKey: `partner_appeal_resolved:${appeal.id}`,
        },
      )
      .catch((err) =>
        this.logger.error(
          `[appeals.resolve] email dispatch failed appeal=${appeal.id}: ${(err as Error).message}`,
        ),
      );
    // If this triggered a ban, send the ban notice too (the appeal
    // email covers the reinstatement / denial case, but the ban
    // email is the definitive "your account is closed" copy).
    if (triggersBan) {
      void this.mail
        .send(
          MailEvent.PARTNER_ACCOUNT_BANNED,
          partner.email,
          {
            recipientName: partner.fullName,
            partnerName: partner.fullName,
            reason: `Third denied appeal (#${appeal.appealNumber}).`,
          },
          {
            userId: partner.userId ?? undefined,
            dedupKey: `partner_banned:${partner.id}`,
          },
        )
        .catch((err) =>
          this.logger.error(
            `[appeals.resolve] ban email failed partner=${partner.id}: ${(err as Error).message}`,
          ),
        );
    }
    return appeal;
  }
}
