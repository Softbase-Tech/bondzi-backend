import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { PartnerStatus } from '../../common/types/enums';
import { generateReferralCode } from '../../common/utils/referral-code.util';
import { MailService } from '../mail/mail.service';
import { MailEvent } from '../mail/mail.types';
import { User } from '../users/entities/user.entity';
import { CreateReferralCodeDto } from './dto/create-referral-code.dto';
import { RegisterPartnerDto } from './dto/register-partner.dto';
import { UpdatePartnerMomoDto } from './dto/update-partner-momo.dto';
import { PartnerReferralCode } from './entities/partner-referral-code.entity';
import { Partner } from './entities/partner.entity';
import { PartnerTermsService } from './partner-terms.service';

/**
 * Partner lifecycle + referral-code CRUD. Kept intentionally
 * thin — everything that touches money (commissions, payouts) lives
 * in its own service. This class handles:
 *
 *   - Register an existing user as a partner.
 *   - Read a partner's own profile (`/partner/me`).
 *   - Update MoMo details.
 *   - List / create / deactivate referral codes.
 *
 * Approval, terms updates, suspension, appeals, banning are
 * separately gated by admin controllers in Phase 3 and Phase 5.
 */
@Injectable()
export class PartnersService {
  private readonly logger = new Logger(PartnersService.name);

  constructor(
    @InjectRepository(Partner)
    private readonly partnersRepo: Repository<Partner>,
    @InjectRepository(PartnerReferralCode)
    private readonly codesRepo: Repository<PartnerReferralCode>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    private readonly terms: PartnerTermsService,
    private readonly dataSource: DataSource,
    private readonly mail: MailService,
  ) {}

  // --------------------------------------------------------------------
  // Registration
  // --------------------------------------------------------------------

  /**
   * Create a partner row for an existing user. Snapshots the current
   * terms version as `agreed_terms_version_id`. Generates the
   * partner's default referral code inside the same transaction so
   * a partial-register never leaves an orphan Partner row without a
   * code.
   *
   * Guarantees:
   *   - user cannot become a partner twice (UNIQUE partners.user_id)
   *   - partner email cannot collide with an existing partner email
   *   - a fresh default referral code is allocated with the same
   *     collision-retry pattern the student system uses
   */
  async register(userId: string, dto: RegisterPartnerDto): Promise<Partner> {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user || !user.isActive) {
      throw new NotFoundException('User not found.');
    }

    const existing = await this.partnersRepo.findOne({
      where: { userId },
    });
    if (existing) {
      throw new ConflictException(
        'This account is already registered as a partner.',
      );
    }

    const emailClash = await this.partnersRepo
      .createQueryBuilder('p')
      .where('lower(p.email) = lower(:email)', { email: dto.email })
      .getOne();
    if (emailClash) {
      throw new ConflictException(
        'A partner is already registered with this email.',
      );
    }

    const termsVersion = await this.terms.getCurrent();

    const savedPartner = await this.dataSource.transaction(async (em) => {
      const partner = em.getRepository(Partner).create({
        userId,
        email: dto.email.trim().toLowerCase(),
        phone: dto.phone.trim(),
        fullName: dto.fullName.trim(),
        countryCode: 'GH',
        momoProvider: dto.momoProvider,
        momoNumber: dto.momoNumber.trim(),
        momoAccountName: dto.momoAccountName.trim(),
        status: PartnerStatus.PENDING,
        agreedTermsVersionId: termsVersion.id,
        fraudFlagCount: 0,
      });
      const saved = await em.getRepository(Partner).save(partner);

      const code = await this.allocateUniqueCode(dto.fullName, em);
      const defaultCode = em.getRepository(PartnerReferralCode).create({
        partnerId: saved.id,
        code,
        label: 'Default code',
        isDefault: true,
        isActive: true,
      });
      const savedCode = await em
        .getRepository(PartnerReferralCode)
        .save(defaultCode);

      // Attach the freshly-allocated code to the returned envelope
      // via a non-persisted property so the caller (AuthService /
      // controller) can hand it off to the agreement email without
      // an extra fetch.
      (saved as Partner & { defaultCode?: string }).defaultCode =
        savedCode.code;

      return saved;
    });

    // Fire the PARTNER_AGREEMENT email OUTSIDE the transaction.
    // Failure to send never rolls back a legitimate partner account;
    // audit + retry live on the mail-audit table.
    const defaultCode = (savedPartner as Partner & { defaultCode?: string })
      .defaultCode;
    if (defaultCode) {
      void this.mail
        .send(
          MailEvent.PARTNER_AGREEMENT,
          savedPartner.email,
          {
            recipientName: savedPartner.fullName,
            partnerName: savedPartner.fullName,
            defaultCode,
            termsVersion: termsVersion.version,
            termsBodyMd: termsVersion.bodyMd,
            plusWassceGhs: termsVersion.plusWassce,
            plusNovdecGhs: termsVersion.plusNovdec,
            plusBeceGhs: termsVersion.plusBece,
            signupBatchAmountGhs: termsVersion.signupBatchAmountGhs,
            signupBatchSize: termsVersion.signupBatchSize,
            signupMinCompletedAnswers: termsVersion.signupMinCompletedAnswers,
            answersBonusAmountGhs: termsVersion.answersBonusAmountGhs,
            answersBonusThreshold: termsVersion.answersBonusThreshold,
            attributionWindowDays: termsVersion.attributionWindowDays,
          },
          {
            userId: savedPartner.userId ?? undefined,
            dedupKey: `partner_agreement:${savedPartner.id}`,
          },
        )
        .catch((err) =>
          this.logger.error(
            `[partners.register] agreement email failed partner=${savedPartner.id}: ${(err as Error).message}`,
          ),
        );
    }
    return savedPartner;
  }

  // --------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------

  async findByUserId(userId: string): Promise<Partner | null> {
    return this.partnersRepo.findOne({ where: { userId } });
  }

  async findByUserIdOrThrow(userId: string): Promise<Partner> {
    const row = await this.findByUserId(userId);
    if (!row) {
      throw new NotFoundException('No partner account for this user.');
    }
    return row;
  }

  async findById(id: string): Promise<Partner> {
    const row = await this.partnersRepo.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException('Partner not found.');
    }
    return row;
  }

  // --------------------------------------------------------------------
  // MoMo details
  // --------------------------------------------------------------------

  async updateMomo(
    userId: string,
    dto: UpdatePartnerMomoDto,
  ): Promise<Partner> {
    const partner = await this.findByUserIdOrThrow(userId);
    if (partner.status === PartnerStatus.BANNED) {
      throw new ForbiddenException('Banned partners cannot update details.');
    }
    if (dto.momoProvider) partner.momoProvider = dto.momoProvider;
    if (dto.momoNumber) partner.momoNumber = dto.momoNumber.trim();
    if (dto.momoAccountName)
      partner.momoAccountName = dto.momoAccountName.trim();
    return this.partnersRepo.save(partner);
  }

  // --------------------------------------------------------------------
  // Referral codes
  // --------------------------------------------------------------------

  async listCodes(partnerId: string): Promise<PartnerReferralCode[]> {
    return this.codesRepo.find({
      where: { partnerId },
      order: { isDefault: 'DESC', createdAt: 'ASC' },
    });
  }

  async createCode(
    userId: string,
    dto: CreateReferralCodeDto,
  ): Promise<PartnerReferralCode> {
    const partner = await this.findByUserIdOrThrow(userId);
    if (partner.status === PartnerStatus.BANNED) {
      throw new ForbiddenException('Banned partners cannot create codes.');
    }
    const code = await this.allocateUniqueCode(partner.fullName);
    return this.codesRepo.save(
      this.codesRepo.create({
        partnerId: partner.id,
        code,
        label: dto.label.trim(),
        isDefault: false,
        isActive: true,
      }),
    );
  }

  /**
   * Toggle a non-default code's `is_active` flag. Default codes
   * cannot be deactivated — a partner must always have at least one
   * active code so their existing attributions can still resolve.
   */
  async setCodeActive(
    userId: string,
    codeId: string,
    isActive: boolean,
  ): Promise<PartnerReferralCode> {
    const partner = await this.findByUserIdOrThrow(userId);
    const code = await this.codesRepo.findOne({
      where: { id: codeId, partnerId: partner.id },
    });
    if (!code) {
      throw new NotFoundException('Referral code not found.');
    }
    if (code.isDefault) {
      throw new BadRequestException('The default code cannot be deactivated.');
    }
    code.isActive = isActive;
    return this.codesRepo.save(code);
  }

  /**
   * Case-insensitively find an ACTIVE code across the whole system.
   * Used by PartnerAttributionsService at register-time and by the
   * banner-click landing route in a later phase.
   */
  async findActiveCode(code: string): Promise<PartnerReferralCode | null> {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return null;
    return this.codesRepo.findOne({
      where: { code: trimmed, isActive: true },
    });
  }

  // --------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------

  /**
   * Loop-with-retry allocator for a globally-unique partner code.
   * Also checks the users.referral_code namespace so a student code
   * and a partner code can never be the same string.
   */
  private async allocateUniqueCode(
    seed: string,
    em?: import('typeorm').EntityManager,
  ): Promise<string> {
    const codeRepo = em?.getRepository(PartnerReferralCode) ?? this.codesRepo;
    const userRepo = em?.getRepository(User) ?? this.usersRepo;
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = generateReferralCode(seed);
      const [partnerClash, userClash] = await Promise.all([
        codeRepo.findOne({ where: { code } }),
        userRepo.findOne({ where: { referralCode: code } }),
      ]);
      if (!partnerClash && !userClash) return code;
    }
    // Unreachable in practice (7-char alphanumeric space is ~78bn),
    // but a deterministic longer suffix beats an infinite loop.
    return `${generateReferralCode(seed)}${Math.random()
      .toString(36)
      .slice(2, 6)
      .toUpperCase()}`;
  }
}
