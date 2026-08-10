import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PartnerStatus } from '../../common/types/enums';
import { MailService } from '../mail/mail.service';
import { MailEvent } from '../mail/mail.types';
import { Partner } from './entities/partner.entity';
import { PartnerTermsVersion } from './entities/partner-terms-version.entity';

/**
 * Versioned partner-terms document.
 *
 * Immutability contract: every terms edit INSERTs a new row — never
 * UPDATEs an existing one. Historical commissions pin against their
 * `terms_version_id` at earn time, so retroactive rate edits are
 * impossible by construction. `getCurrent()` returns whichever row
 * is currently "active" (effective_from <= now, highest version); a
 * future-dated version can be staged and will flip live at the
 * declared timestamp.
 *
 * `create()` is admin-only (guarded at controller layer) and
 * broadcasts a PARTNER_TERMS_UPDATED email to every ACTIVE partner
 * so they know the rate card / attribution window / fraud threshold
 * changed.
 */
@Injectable()
export class PartnerTermsService {
  private readonly logger = new Logger(PartnerTermsService.name);

  constructor(
    @InjectRepository(PartnerTermsVersion)
    private readonly termsRepo: Repository<PartnerTermsVersion>,
    @InjectRepository(Partner)
    private readonly partnersRepo: Repository<Partner>,
    // MailModule imports PartnersModule for the payouts service; keep
    // this indirection lazy via forwardRef so the DI graph stays
    // acyclic on cold start.
    @Inject(forwardRef(() => MailService))
    private readonly mail: MailService,
  ) {}

  /**
   * Latest terms version whose `effective_from` is in the past.
   * Falls back to the most recent row if none are yet active (should
   * only happen in a broken seed).
   */
  async getCurrent(): Promise<PartnerTermsVersion> {
    const now = new Date();
    const active = await this.termsRepo
      .createQueryBuilder('t')
      .where('t.effective_from <= :now', { now })
      .orderBy('t.effective_from', 'DESC')
      .addOrderBy('t.version', 'DESC')
      .getOne();
    if (active) return active;

    const fallback = await this.termsRepo
      .createQueryBuilder('t')
      .orderBy('t.version', 'DESC')
      .getOne();
    if (!fallback) {
      throw new NotFoundException(
        'No partner terms versions have been seeded.',
      );
    }
    return fallback;
  }

  async findById(id: string): Promise<PartnerTermsVersion> {
    const row = await this.termsRepo.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException('Terms version not found.');
    }
    return row;
  }

  async listAll(): Promise<PartnerTermsVersion[]> {
    return this.termsRepo.find({ order: { version: 'DESC' } });
  }

  /**
   * Create a new terms version. Admin-only. Auto-increments the
   * `version` column, snapshots the admin id, and broadcasts the
   * PARTNER_TERMS_UPDATED email to every ACTIVE partner.
   *
   * `effectiveFrom` defaults to NOW so the new terms are the
   * active version immediately. Admin may pass a future date to
   * stage a change.
   */
  async createNewVersion(input: {
    createdBy: string;
    title: string;
    bodyMd: string;
    changeSummary: string;
    plusWassce: string;
    plusNovdec: string;
    plusBece: string;
    signupBatchSize?: number;
    signupBatchAmountGhs?: string;
    signupMinCompletedAnswers?: number;
    answersBonusThreshold?: number;
    answersBonusAmountGhs?: string;
    attributionWindowDays?: number;
    maxFraudFlagsBeforeBlock?: number;
    maxAppeals?: number;
    effectiveFrom?: Date;
  }): Promise<PartnerTermsVersion> {
    // Guard against empty/whitespace-only bodies — the row goes into
    // every future agreement email; blank text is worse than useless.
    if (!input.title.trim() || !input.bodyMd.trim()) {
      throw new BadRequestException('Title and body are required.');
    }
    if (!input.changeSummary.trim()) {
      throw new BadRequestException('Change summary is required.');
    }

    // Next version number — read from the current MAX. Race-safe
    // enough: the (version) column has a UNIQUE constraint at the
    // DB layer, so a colliding insert throws and the caller can
    // retry. For a low-frequency admin write path (weeks or months
    // between edits) that's more than enough.
    const highest = await this.termsRepo
      .createQueryBuilder('t')
      .select('MAX(t.version)', 'max')
      .getRawOne<{ max: number | string | null }>();
    const nextVersion = Number(highest?.max ?? 0) + 1;

    const created = await this.termsRepo.save(
      this.termsRepo.create({
        version: nextVersion,
        title: input.title.trim(),
        bodyMd: input.bodyMd.trim(),
        plusWassce: input.plusWassce,
        plusNovdec: input.plusNovdec,
        plusBece: input.plusBece,
        signupBatchSize: input.signupBatchSize ?? 10,
        signupBatchAmountGhs: input.signupBatchAmountGhs ?? '20.00',
        signupMinCompletedAnswers: input.signupMinCompletedAnswers ?? 40,
        answersBonusThreshold: input.answersBonusThreshold ?? 100,
        answersBonusAmountGhs: input.answersBonusAmountGhs ?? '2.00',
        attributionWindowDays: input.attributionWindowDays ?? 90,
        maxFraudFlagsBeforeBlock: input.maxFraudFlagsBeforeBlock ?? 3,
        maxAppeals: input.maxAppeals ?? 3,
        effectiveFrom: input.effectiveFrom ?? new Date(),
        createdBy: input.createdBy,
      }),
    );

    // Broadcast. Fetch active partners in-flight (small table — no
    // pagination needed for the first many thousand partners) and
    // fan out one email per row, best-effort. Fire on a promise
    // pool so a Resend blip doesn't hold up the response.
    const activePartners = await this.partnersRepo.find({
      where: { status: PartnerStatus.ACTIVE },
      select: ['id', 'userId', 'email', 'fullName'],
    });
    const portalBase = (this.mail.getWebUrl() ?? '').replace(/\/$/, '');
    const termsUrl = `${portalBase}/partner/profile`;
    void Promise.all(
      activePartners.map((p) =>
        this.mail
          .send(
            MailEvent.PARTNER_TERMS_UPDATED,
            p.email,
            {
              recipientName: p.fullName,
              partnerName: p.fullName,
              newVersion: created.version,
              changeSummary: input.changeSummary.trim(),
              effectiveFrom: created.effectiveFrom,
              termsUrl,
            },
            {
              userId: p.userId ?? undefined,
              // Dedup by (version, partner) so a retried admin write
              // doesn't spam partners twice — mail-audit absorbs it.
              dedupKey: `partner_terms_updated:${created.id}:${p.id}`,
            },
          )
          .catch((err) =>
            this.logger.error(
              `[terms.create] broadcast failed partner=${p.id}: ${(err as Error).message}`,
            ),
          ),
      ),
    ).catch(() => void 0);

    return created;
  }
}
