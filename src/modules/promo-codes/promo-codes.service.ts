import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  AccountType,
  ExamType,
  PromoDiscountType,
} from '../../common/types/enums';
import { PromoCode } from './entities/promo-code.entity';
import { PromoRedemption } from './entities/promo-redemption.entity';
import { SubscriptionPlanEntity } from '../subscriptions/plans/entities/subscription-plan.entity';
import {
  CreatePromoCodeDto,
  UpdatePromoCodeDto,
} from './dto/promo-code.dto';

/**
 * Promo / discount code lifecycle.
 *
 * The service exposes two distinct surfaces:
 *
 *  1. **Admin CRUD** — create, list, update, soft-delete codes.
 *     Codes are stored lowercased so redemption is case-insensitive
 *     without per-query `LOWER()` calls.
 *
 *  2. **Checkout primitives** — `quote(code, plan, userId)` returns the
 *     discount applicable to a (code, plan, user) tuple, OR null if the
 *     code can't be applied (wrong scope, expired, exhausted, already
 *     redeemed by this user). `recordRedemption(...)` is called by the
 *     subscriptions checkout once the payment succeeds — it increments
 *     `redeemedCount` and inserts the ledger row atomically.
 *
 * Concurrency: `redeemedCount` is bumped via a conditional UPDATE inside
 * a transaction so two parallel checkouts can't over-spend a code with
 * `maxRedemptions = N`. The unique index on
 * `(promo_code_id, user_id)` prevents the same user from redeeming
 * twice — a second attempt collides on the index and the transaction
 * rolls back.
 */
@Injectable()
export class PromoCodesService {
  private readonly logger = new Logger(PromoCodesService.name);

  constructor(
    @InjectRepository(PromoCode)
    private readonly codesRepo: Repository<PromoCode>,
    @InjectRepository(PromoRedemption)
    private readonly redemptionsRepo: Repository<PromoRedemption>,
    private readonly dataSource: DataSource,
  ) {}

  // ----- Admin CRUD -------------------------------------------------------

  list(): Promise<PromoCode[]> {
    return this.codesRepo.find({ order: { createdAt: 'DESC' } });
  }

  async getById(id: string): Promise<PromoCode> {
    const row = await this.codesRepo.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Promo code ${id} not found.`);
    return row;
  }

  async create(
    adminId: string,
    dto: CreatePromoCodeDto,
  ): Promise<PromoCode> {
    const code = dto.code.toLowerCase().trim();
    // Surface the collision as 409 with a clear message — the DB error
    // would also block it via the UNIQUE constraint, but the duplicate
    // case is common enough (admin retypes a code) to deserve a
    // friendly message.
    const existing = await this.codesRepo.findOne({ where: { code } });
    if (existing) {
      throw new ConflictException(
        `Promo code '${code}' already exists. Codes are case-insensitive.`,
      );
    }
    // Validate percent ceiling — DB has the CHECK but the API rejects
    // it earlier with a clearer message.
    if (
      dto.discountType === PromoDiscountType.PERCENT &&
      dto.discountValue > 100
    ) {
      throw new BadRequestException(
        'Percent discounts must be 0–100.',
      );
    }
    const row = this.codesRepo.create({
      code,
      description: dto.description ?? null,
      discountType: dto.discountType,
      discountValue: dto.discountValue.toFixed(2),
      applicableAccount: dto.applicableAccount ?? null,
      applicableLevel: dto.applicableLevel ?? null,
      maxRedemptions: dto.maxRedemptions ?? null,
      redeemedCount: 0,
      validFrom: dto.validFrom ? new Date(dto.validFrom) : null,
      validUntil: dto.validUntil ? new Date(dto.validUntil) : null,
      isActive: dto.isActive ?? true,
      createdBy: adminId,
    });
    return this.codesRepo.save(row);
  }

  async update(id: string, dto: UpdatePromoCodeDto): Promise<PromoCode> {
    const row = await this.getById(id);
    if (dto.description !== undefined) row.description = dto.description;
    if (dto.discountValue !== undefined) {
      if (
        row.discountType === PromoDiscountType.PERCENT &&
        dto.discountValue > 100
      ) {
        throw new BadRequestException(
          'Percent discounts must be 0–100.',
        );
      }
      row.discountValue = dto.discountValue.toFixed(2);
    }
    if (dto.maxRedemptions !== undefined) {
      if (dto.maxRedemptions < row.redeemedCount) {
        throw new BadRequestException(
          `Cannot set maxRedemptions below the current redeemedCount (${row.redeemedCount}).`,
        );
      }
      row.maxRedemptions = dto.maxRedemptions;
    }
    if (dto.validUntil !== undefined) {
      row.validUntil = dto.validUntil ? new Date(dto.validUntil) : null;
    }
    if (dto.isActive !== undefined) row.isActive = dto.isActive;
    return this.codesRepo.save(row);
  }

  async delete(id: string): Promise<void> {
    const res = await this.codesRepo.delete({ id });
    if (res.affected === 0) {
      throw new NotFoundException(`Promo code ${id} not found.`);
    }
  }

  // ----- Checkout primitives ---------------------------------------------

  /**
   * Resolve a code string for use against a candidate plan. Returns the
   * computed discount amount (in plan currency) and the underlying row,
   * or null when the code is unusable. Use the returned `quote` to
   * present a price preview before charging.
   */
  async quote(
    code: string,
    plan: SubscriptionPlanEntity,
    userId: string,
    grossAmount: number,
  ): Promise<{ code: PromoCode; discountAmount: number } | null> {
    const normalised = code.toLowerCase().trim();
    if (!normalised) return null;
    const row = await this.codesRepo.findOne({ where: { code: normalised } });
    if (!row) return null;
    if (!row.isActive) return null;
    const now = Date.now();
    if (row.validFrom && row.validFrom.getTime() > now) return null;
    if (row.validUntil && row.validUntil.getTime() < now) return null;
    if (
      row.maxRedemptions !== null &&
      row.redeemedCount >= row.maxRedemptions
    ) {
      return null;
    }
    // Scope filters: NULL means "no restriction on this dimension".
    if (
      row.applicableAccount !== null &&
      row.applicableAccount !== plan.account
    ) {
      return null;
    }
    if (row.applicableLevel !== null && row.applicableLevel !== plan.level) {
      return null;
    }
    // Already redeemed by this user?
    const prior = await this.redemptionsRepo.findOne({
      where: { promoCodeId: row.id, userId },
    });
    if (prior) return null;

    const discountAmount = this.computeDiscount(row, grossAmount);
    return { code: row, discountAmount };
  }

  /**
   * Atomically increment the redeemed count and write the ledger row.
   * Caller (subscriptions checkout) holds the (user, code) uniqueness
   * via the DB index — concurrent attempts collide here and the second
   * one rolls back.
   */
  async recordRedemption(args: {
    codeId: string;
    userId: string;
    subscriptionId: string | null;
    discountAmount: number;
    currency: string;
  }): Promise<void> {
    await this.dataSource.transaction(async (trx) => {
      // Conditional bump — atomic under the row-level lock. If the cap
      // was hit between `quote()` and `recordRedemption()` (race with
      // another user redeeming), the affected count is 0 and we throw.
      const result = await trx
        .createQueryBuilder()
        .update(PromoCode)
        .set({ redeemedCount: () => 'redeemed_count + 1' })
        .where(
          'id = :id AND is_active = true AND (max_redemptions IS NULL OR redeemed_count < max_redemptions)',
          { id: args.codeId },
        )
        .execute();
      if (result.affected === 0) {
        throw new ConflictException(
          'Promo code is no longer redeemable (cap reached or deactivated).',
        );
      }
      await trx.getRepository(PromoRedemption).save(
        trx.getRepository(PromoRedemption).create({
          promoCodeId: args.codeId,
          userId: args.userId,
          subscriptionId: args.subscriptionId,
          discountAmount: args.discountAmount.toFixed(2),
          currency: args.currency,
        }),
      );
    });
  }

  // ----- helpers ----------------------------------------------------------

  private computeDiscount(row: PromoCode, grossAmount: number): number {
    const value = parseFloat(row.discountValue);
    if (row.discountType === PromoDiscountType.PERCENT) {
      // Round to 2 decimals so a 15% discount on 200 GHS lands at 30.00
      // not 30.0000001.
      return Math.round(((grossAmount * value) / 100) * 100) / 100;
    }
    // Fixed: never discount more than the gross — a 50 GHS code applied
    // to a 30 GHS plan gives a free plan, not a credit.
    return Math.min(Math.round(value * 100) / 100, grossAmount);
  }
}

// Surface unused imports so the file is self-documenting about its
// type-level dependencies — these enums are reachable via the entity
// columns and DTOs even though they aren't named in the service body.
void AccountType;
void ExamType;
