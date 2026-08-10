import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, IsNull, Repository } from 'typeorm';
import {
  MomoProvider,
  PartnerCommissionStatus,
  PartnerCommissionType,
  PartnerPayoutStatus,
  PartnerStatus,
} from '../../common/types/enums';
import { MailService } from '../mail/mail.service';
import { MailEvent } from '../mail/mail.types';
import { generatePartnerInvoicePdf } from '../mail/pdf/partner-invoice.pdf';
import { PartnerCommission } from './entities/partner-commission.entity';
import { PartnerPayout } from './entities/partner-payout.entity';
import { Partner } from './entities/partner.entity';

/**
 * Preview envelope returned by `previewNextPayout`. Admin UI shows this
 * before calling `create` so the amount and the line-items are visible
 * ahead of committing.
 */
export interface PayoutPreview {
  partnerId: string;
  totalGhs: string;
  commissionCount: number;
  commissions: PartnerCommission[];
}

/**
 * Partner payout lifecycle: preview → create → markPaid → (optionally)
 * markFailed.
 *
 * Rules (per plan doc §5):
 *   - Only commissions with status = APPROVED are eligible for a payout.
 *   - Only ACTIVE partners can be paid out. PENDING partners accrue
 *     APPROVED commissions but cannot cash out until admin flips them
 *     active. SUSPENDED / BANNED partners are frozen.
 *   - Negative offset commissions (plus_subscription_clawback) net into
 *     the total when they're APPROVED. A partner whose clawbacks exceed
 *     their positive earnings owes Bondzi — we refuse to create a
 *     zero/negative payout (the balance stays on the ledger, offsets
 *     will consume future positives).
 *   - Each payout row locks its commissions by setting
 *     paid_out_id + flipping status to PAID.
 *   - MoMo details (provider + number) are SNAPSHOTTED onto the payout
 *     row at create time so a later partner-profile edit can't rewrite
 *     the history of what was actually paid.
 *   - Invoice number is generated deterministically: `INV-<YYYYMMDD>-<6char>`
 *     and enforced UNIQUE at the DB layer.
 *
 * markFailed reverses: commissions revert to APPROVED so a fresh payout
 * can be issued. The failed row stays for audit; the partial unique
 * index (partner_id, week_of) excludes failed rows, so retries are OK.
 */
@Injectable()
export class PartnerPayoutsService {
  private readonly logger = new Logger(PartnerPayoutsService.name);

  constructor(
    @InjectRepository(PartnerPayout)
    private readonly payoutsRepo: Repository<PartnerPayout>,
    @InjectRepository(PartnerCommission)
    private readonly commissionsRepo: Repository<PartnerCommission>,
    @InjectRepository(Partner)
    private readonly partnersRepo: Repository<Partner>,
    private readonly mail: MailService,
    private readonly dataSource: DataSource,
  ) {}

  // --------------------------------------------------------------------
  // Preview
  // --------------------------------------------------------------------

  /**
   * Compute the payout envelope for a partner as of NOW. The returned
   * commissions are candidates only — the `create` call is what
   * actually locks them onto a payout row. Safe to call repeatedly.
   */
  async previewNextPayout(partnerId: string): Promise<PayoutPreview> {
    const commissions = await this.eligibleCommissionsFor(partnerId);
    const total = sumAmounts(commissions);
    return {
      partnerId,
      totalGhs: total.toFixed(2),
      commissionCount: commissions.length,
      commissions,
    };
  }

  private eligibleCommissionsFor(
    partnerId: string,
  ): Promise<PartnerCommission[]> {
    return this.commissionsRepo.find({
      where: {
        partnerId,
        status: PartnerCommissionStatus.APPROVED,
        paidOutId: IsNull(),
      },
      order: { earnedAt: 'ASC' },
    });
  }

  // --------------------------------------------------------------------
  // Create
  // --------------------------------------------------------------------

  /**
   * Create a payout row for the given partner. Blocks all approved &
   * unpaid commissions, snapshots MoMo details, generates a unique
   * invoice number. Returns the freshly-inserted payout row.
   *
   * Idempotency: `notes` can carry a caller-supplied dedup marker (e.g.
   * a UI action id) but we don't enforce it at the DB layer for this
   * table — the partial unique index on (partner_id, week_of) already
   * prevents two live payouts for the same week. Admin retrying create
   * for the same week after a first-call throw will hit the constraint
   * and 409.
   */
  async createPayout(
    partnerId: string,
    opts: {
      weekOf?: string;
      notes?: string | null;
    } = {},
  ): Promise<PartnerPayout> {
    const partner = await this.partnersRepo.findOne({
      where: { id: partnerId },
    });
    if (!partner) {
      throw new NotFoundException('Partner not found.');
    }
    if (partner.status !== PartnerStatus.ACTIVE) {
      throw new BadRequestException(
        `Partner is ${partner.status}; only ACTIVE partners can be paid out.`,
      );
    }

    return this.dataSource.transaction(async (em) => {
      // Lock candidate commissions FOR UPDATE so a parallel createPayout
      // can't grab the same rows twice. SKIP LOCKED would let both
      // succeed with empty envelopes — for payouts we want the second
      // call to see nothing and refuse.
      const candidates = await em
        .getRepository(PartnerCommission)
        .createQueryBuilder('c')
        .setLock('pessimistic_write')
        .where('c.partner_id = :pid', { pid: partnerId })
        .andWhere(`c.status = 'approved'`)
        .andWhere('c.paid_out_id IS NULL')
        .orderBy('c.earned_at', 'ASC')
        .getMany();

      if (candidates.length === 0) {
        throw new BadRequestException(
          'No approved-and-unpaid commissions to pay out.',
        );
      }

      const total = sumAmounts(candidates);
      if (total <= 0) {
        throw new BadRequestException(
          `Payout balance is ${total.toFixed(2)} — clawbacks exceed positive earnings. Balance stays on the ledger.`,
        );
      }

      const weekOf = opts.weekOf ?? currentMondayIso(candidates[0].earnedAt);
      const invoiceNumber = allocateInvoiceNumber();

      const payoutsRepo = em.getRepository(PartnerPayout);
      let saved: PartnerPayout;
      try {
        saved = await payoutsRepo.save(
          payoutsRepo.create({
            partnerId,
            weekOf,
            amountGhs: total.toFixed(2),
            status: PartnerPayoutStatus.PENDING,
            invoiceNumber,
            invoicePdfUrl: null,
            momoProvider: partner.momoProvider,
            momoNumber: partner.momoNumber,
            momoReference: null,
            markedPaidBy: null,
            markedPaidAt: null,
            notes: opts.notes ?? null,
          }),
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            'A live payout for this partner + week already exists.',
          );
        }
        throw err;
      }

      // Lock the commissions to this payout. Status stays APPROVED until
      // the payout is marked PAID; leaving them APPROVED here means an
      // errant re-run of `create` doesn't fetch them again (paidOutId is
      // now non-null and the WHERE clause excludes them).
      await em
        .getRepository(PartnerCommission)
        .createQueryBuilder()
        .update()
        .set({ paidOutId: saved.id })
        .whereInIds(candidates.map((c) => c.id))
        .execute();

      return saved;
    });
  }

  // --------------------------------------------------------------------
  // Mark paid
  // --------------------------------------------------------------------

  /**
   * Flip a payout from PENDING → PAID. Stamps momo_reference + admin id
   * + timestamp, flips every attached commission to PAID, generates the
   * invoice PDF, and sends the PARTNER_PAYOUT_PAID email with the PDF
   * attached.
   *
   * Idempotency: a PAID row here is a no-op (returns unchanged); no
   * duplicate email fires (mail service dedupes on `payout_paid:<id>`).
   */
  async markPaid(input: {
    payoutId: string;
    adminUserId: string;
    momoReference: string;
  }): Promise<PartnerPayout> {
    const payout = await this.payoutsRepo.findOne({
      where: { id: input.payoutId },
    });
    if (!payout) throw new NotFoundException('Payout not found.');
    if (payout.status === PartnerPayoutStatus.PAID) return payout;
    if (payout.status !== PartnerPayoutStatus.PENDING) {
      throw new BadRequestException(
        `Payout is ${payout.status}; only PENDING payouts can be marked paid.`,
      );
    }
    if (!input.momoReference?.trim()) {
      throw new BadRequestException('MoMo reference is required.');
    }

    const paidAt = new Date();
    const trimmedRef = input.momoReference.trim();

    await this.dataSource.transaction(async (em) => {
      const p = await em.getRepository(PartnerPayout).findOne({
        where: { id: input.payoutId },
      });
      if (!p) throw new NotFoundException('Payout not found.');
      p.status = PartnerPayoutStatus.PAID;
      p.momoReference = trimmedRef;
      p.markedPaidBy = input.adminUserId;
      p.markedPaidAt = paidAt;
      await em.getRepository(PartnerPayout).save(p);

      // Flip every attached commission to PAID in a single UPDATE.
      await em
        .getRepository(PartnerCommission)
        .createQueryBuilder()
        .update()
        .set({ status: PartnerCommissionStatus.PAID })
        .where('paid_out_id = :pid', { pid: p.id })
        .execute();
    });

    // Reload with commissions for the invoice + email. Merge the
    // freshly-committed fields onto the stale row we loaded up-top
    // so the email carries the reference the admin actually filed
    // (not the pre-mark null).
    const paidPayout: PartnerPayout = {
      ...payout,
      status: PartnerPayoutStatus.PAID,
      momoReference: trimmedRef,
      markedPaidBy: input.adminUserId,
      markedPaidAt: paidAt,
    };
    const partner = await this.partnersRepo.findOne({
      where: { id: payout.partnerId },
    });
    const commissions = await this.commissionsRepo.find({
      where: { paidOutId: payout.id },
      order: { earnedAt: 'ASC' },
    });

    if (partner) {
      await this.dispatchPayoutPaidEmail(
        partner,
        paidPayout,
        commissions,
        paidAt,
      );
    }
    return paidPayout;
  }

  // --------------------------------------------------------------------
  // Mark failed
  // --------------------------------------------------------------------

  /**
   * Reverse a PENDING or PAID payout. Commissions revert to APPROVED
   * (paid_out_id cleared) so a fresh payout can be created. Fails-loud
   * on already-FAILED rows so admin doesn't accidentally double-revert.
   */
  async markFailed(input: {
    payoutId: string;
    adminUserId: string;
    reason: string;
  }): Promise<PartnerPayout> {
    const payout = await this.payoutsRepo.findOne({
      where: { id: input.payoutId },
    });
    if (!payout) throw new NotFoundException('Payout not found.');
    if (payout.status === PartnerPayoutStatus.FAILED) {
      throw new BadRequestException('Payout is already marked failed.');
    }

    await this.dataSource.transaction(async (em) => {
      const p = await em.getRepository(PartnerPayout).findOne({
        where: { id: input.payoutId },
      });
      if (!p) return;
      p.status = PartnerPayoutStatus.FAILED;
      p.notes = joinNotes(
        p.notes,
        `FAILED (${input.adminUserId}): ${input.reason}`,
      );
      await em.getRepository(PartnerPayout).save(p);

      // Revert commissions: unlink + reset to APPROVED. PAID → APPROVED
      // is correct here because the payout is being unwound as if it
      // never happened.
      await em
        .getRepository(PartnerCommission)
        .createQueryBuilder()
        .update()
        .set({
          paidOutId: null,
          status: PartnerCommissionStatus.APPROVED,
        })
        .where('paid_out_id = :pid', { pid: p.id })
        .execute();
    });

    return {
      ...payout,
      status: PartnerPayoutStatus.FAILED,
      notes: joinNotes(
        payout.notes,
        `FAILED (${input.adminUserId}): ${input.reason}`,
      ),
    };
  }

  // --------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------

  async listForPartner(partnerId: string): Promise<PartnerPayout[]> {
    return this.payoutsRepo.find({
      where: { partnerId },
      order: { createdAt: 'DESC' },
    });
  }

  async listAll(filter: {
    status?: PartnerPayoutStatus;
    partnerId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: PartnerPayout[]; total: number }> {
    const qb = this.payoutsRepo
      .createQueryBuilder('p')
      .orderBy('p.created_at', 'DESC');
    if (filter.status) qb.andWhere('p.status = :st', { st: filter.status });
    if (filter.partnerId)
      qb.andWhere('p.partner_id = :pid', { pid: filter.partnerId });
    qb.take(filter.limit ?? 50).skip(filter.offset ?? 0);
    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }

  /**
   * Rebuild the invoice PDF for a payout — used by the "download
   * invoice" endpoint when Cloudinary isn't yet wired. Every call
   * regenerates from the source-of-truth commission rows, so a
   * partner viewing their old invoices sees the same numbers even
   * after retroactive edits are (never) allowed.
   */
  async buildInvoicePdf(payoutId: string): Promise<{
    filename: string;
    buffer: Buffer;
  }> {
    const payout = await this.payoutsRepo.findOne({ where: { id: payoutId } });
    if (!payout) throw new NotFoundException('Payout not found.');
    const partner = await this.partnersRepo.findOne({
      where: { id: payout.partnerId },
    });
    if (!partner) throw new NotFoundException('Partner not found.');
    const commissions = await this.commissionsRepo.find({
      where: { paidOutId: payout.id },
      order: { earnedAt: 'ASC' },
    });
    const buffer = await generatePartnerInvoicePdf({
      invoiceNumber: payout.invoiceNumber,
      partnerName: partner.fullName,
      partnerEmail: partner.email,
      momoProvider: momoLabel(payout.momoProvider),
      momoNumber: payout.momoNumber,
      momoReference: payout.momoReference ?? '(pending)',
      weekOf: payout.weekOf,
      paidAt: payout.markedPaidAt ?? payout.createdAt,
      currency: 'GHS',
      totalAmount: payout.amountGhs,
      lines: commissions.map((c) => ({
        description: describeCommission(c),
        amountGhs: c.amountGhs,
        earnedAt: c.earnedAt?.toISOString?.() ?? undefined,
      })),
    });
    return {
      filename: `bondzi-partner-invoice-${payout.invoiceNumber}.pdf`,
      buffer,
    };
  }

  // --------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------

  private async dispatchPayoutPaidEmail(
    partner: Partner,
    payout: PartnerPayout,
    commissions: PartnerCommission[],
    paidAt: Date,
  ): Promise<void> {
    try {
      const pdf = await generatePartnerInvoicePdf({
        invoiceNumber: payout.invoiceNumber,
        partnerName: partner.fullName,
        partnerEmail: partner.email,
        momoProvider: momoLabel(payout.momoProvider),
        momoNumber: payout.momoNumber,
        momoReference: payout.momoReference ?? '(pending)',
        weekOf: payout.weekOf,
        paidAt,
        currency: 'GHS',
        totalAmount: payout.amountGhs,
        lines: commissions.map((c) => ({
          description: describeCommission(c),
          amountGhs: c.amountGhs,
          earnedAt: c.earnedAt?.toISOString?.() ?? undefined,
        })),
      });

      await this.mail.send(
        MailEvent.PARTNER_PAYOUT_PAID,
        partner.email,
        {
          recipientName: partner.fullName,
          partnerName: partner.fullName,
          amountDisplay: payout.amountGhs,
          currency: 'GHS',
          weekOf: payout.weekOf,
          invoiceNumber: payout.invoiceNumber,
          momoProvider: momoLabel(payout.momoProvider),
          momoNumber: payout.momoNumber,
          momoReference: payout.momoReference ?? '',
          commissionCount: commissions.length,
          paidAt,
        },
        {
          userId: partner.userId ?? undefined,
          dedupKey: `partner_payout_paid:${payout.id}`,
          idempotencyKey: `partner_payout_paid:${payout.id}`,
          attachments: [
            {
              filename: `bondzi-partner-invoice-${payout.invoiceNumber}.pdf`,
              content: pdf,
              contentType: 'application/pdf',
            },
          ],
        },
      );
    } catch (err) {
      // Email + PDF are best-effort. The payout is already committed;
      // ops can regenerate + resend later via the "download invoice"
      // admin action.
      this.logger.error(
        `[payouts.markPaid] email dispatch failed payout=${payout.id}: ${(err as Error).message}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sumAmounts(commissions: PartnerCommission[]): number {
  let sum = 0;
  for (const c of commissions) sum += Number(c.amountGhs);
  return Number(sum.toFixed(2));
}

/**
 * Deterministic invoice number: INV-<YYYYMMDD>-<8char>. Kept human-
 * readable so partners can quote it in emails; the random suffix is
 * enough entropy to make guessing another partner's invoice
 * impractical (32-bit ≈ 4bn combos per date). The DB's UNIQUE index
 * catches the astronomically unlikely collision.
 */
function allocateInvoiceNumber(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  return `INV-${yyyy}${mm}${dd}-${suffix}`;
}

/**
 * Return the ISO date (YYYY-MM-DD) of the Monday of the week `date`
 * falls in. Used to populate payout.week_of when the admin doesn't
 * override it.
 */
function currentMondayIso(date: Date): string {
  const d = new Date(date);
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day; // shift to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const asRecord = err as Record<string, unknown>;
  if (asRecord.code === '23505') return true;
  const driver = asRecord.driverError as { code?: string } | undefined;
  return driver?.code === '23505';
}

function joinNotes(existing: string | null, addition: string): string {
  if (!existing) return addition;
  return `${existing}\n${addition}`;
}

function momoLabel(p: MomoProvider): string {
  switch (p) {
    case MomoProvider.MTN:
      return 'MTN MoMo';
    case MomoProvider.AIRTELTIGO:
      return 'AirtelTigo Money';
    case MomoProvider.TELECEL:
      return 'Telecel Cash';
    case MomoProvider.OTHER:
    default:
      return 'MoMo';
  }
}

/**
 * Human-readable description for one commission on the invoice.
 * Signup batches show "Signup batch (10 users)", answer bonuses show
 * "Answers bonus", Plus commissions show the user id short-form, and
 * clawbacks explicitly say "Clawback".
 */
function describeCommission(c: PartnerCommission): string {
  switch (c.type) {
    case PartnerCommissionType.PLUS_SUBSCRIPTION:
      return `Plus subscription commission${c.userId ? ` — user ${c.userId.slice(0, 8)}` : ''}`;
    case PartnerCommissionType.SIGNUP_BATCH: {
      const count = Array.isArray(c.batchUserIds) ? c.batchUserIds.length : 0;
      return count ? `Signup batch (${count} users)` : 'Signup batch';
    }
    case PartnerCommissionType.ANSWERS_BONUS:
      return `Answers bonus${c.userId ? ` — user ${c.userId.slice(0, 8)}` : ''}`;
    case PartnerCommissionType.PLUS_SUBSCRIPTION_CLAWBACK:
      return `Clawback${c.subscriptionId ? ` — sub ${c.subscriptionId.slice(0, 8)}` : ''}`;
    default:
      return String(c.type);
  }
}
