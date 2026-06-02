import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { BillingInterval, PaymentKind } from '../../../common/types/enums';
import { AuditLog } from '../../admin/entities/audit-log.entity';
import { PaymentProviderRegistry } from '../../payments/providers/payment-provider.registry';
import { CreatePlanDto } from './dto/create-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';
import { SubscriptionPlanEntity } from './entities/subscription-plan.entity';

/**
 * Per-cadence pesewa amount (display float × 100). Callers pay in the
 * currency's minor unit everywhere — this keeps the provider call sites
 * consistent across GHS, NGN, USD, etc.
 */
interface CadencePricing {
  cadence: 'monthly' | 'six_month' | 'annual';
  interval: BillingInterval;
  amountMinor: number;
  durationDays: number;
}

@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);

  constructor(
    @InjectRepository(SubscriptionPlanEntity)
    private readonly plansRepo: Repository<SubscriptionPlanEntity>,
    @InjectRepository(AuditLog)
    private readonly auditRepo: Repository<AuditLog>,
    private readonly providers: PaymentProviderRegistry,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  // --- Queries ---------------------------------------------------------------

  async list(options?: {
    countryCode?: string;
    includeInactive?: boolean;
  }): Promise<SubscriptionPlanEntity[]> {
    const qb = this.plansRepo.createQueryBuilder('p');
    if (options?.countryCode) {
      qb.andWhere('p.country_code = :cc', { cc: options.countryCode });
    }
    if (!options?.includeInactive) {
      qb.andWhere('p.is_active = true');
      // #73: plans in the version-bump grace period stay isActive=true
      // so the webhook handler can resolve them by code, but they
      // SHOULD NOT appear in any public listing. Filter them out for
      // the catalogue path. Admin views (includeInactive=true) still
      // see them so the price-change UI can show "expiring at X".
      qb.andWhere('(p.archive_at IS NULL OR p.archive_at > NOW())');
    }
    return qb.orderBy('p.created_at', 'DESC').getMany();
  }

  async getById(id: string): Promise<SubscriptionPlanEntity> {
    const plan = await this.plansRepo.findOne({ where: { id } });
    if (!plan) throw new NotFoundException('Plan not found');
    return plan;
  }

  async getDefaultForCountry(
    countryCode: string,
  ): Promise<SubscriptionPlanEntity | null> {
    return this.plansRepo.findOne({
      where: { countryCode, isActive: true, isDefault: true },
    });
  }

  /** Resolve the active plan + cadence row for checkout. Returns the full row. */
  async getActiveForCheckout(id: string): Promise<SubscriptionPlanEntity> {
    const plan = await this.getById(id);
    if (!plan.isActive) {
      throw new BadRequestException(
        'This plan is archived and cannot be purchased. Pick an active plan.',
      );
    }
    return plan;
  }

  // --- Create ----------------------------------------------------------------

  async create(
    adminId: string,
    dto: CreatePlanDto,
  ): Promise<SubscriptionPlanEntity> {
    if (!this.providers.has(dto.provider)) {
      throw new BadRequestException(
        `Provider '${dto.provider}' is not registered. Available: ${this.providers
          .names()
          .join(', ')}`,
      );
    }

    const isOneTime = dto.paymentKind === PaymentKind.ONE_TIME;
    // One-time (Plus) plans must not carry cadence prices — they have a
    // single headline price stored in `monthlyPrice`. Reject early so a
    // typo in the admin form doesn't quietly create a malformed plan
    // with both lifetime semantics AND a non-zero 6-month price.
    if (isOneTime && (dto.sixMonthPrice ?? 0) > 0) {
      throw new BadRequestException(
        'One-time (Plus) plans cannot define sixMonthPrice — leave it at 0 or omit.',
      );
    }
    if (isOneTime && (dto.annualPrice ?? 0) > 0) {
      throw new BadRequestException(
        'One-time (Plus) plans cannot define annualPrice — leave it at 0 or omit.',
      );
    }
    if (!isOneTime && (!dto.sixMonthPrice || !dto.annualPrice)) {
      throw new BadRequestException(
        'Recurring (Pro) plans require monthlyPrice, sixMonthPrice and annualPrice.',
      );
    }

    // One-time plans do not need provider plan codes (Paystack charges
    // them as single transactions). Recurring plans always sync unless
    // explicitly opted out — admin can still sync later via the
    // /admin/plans/:id/sync endpoint.
    const shouldSync = !isOneTime && dto.syncProvider !== false;
    let codes: {
      monthly: string | null;
      sixMonth: string | null;
      annual: string | null;
    } = { monthly: null, sixMonth: null, annual: null };

    if (shouldSync) {
      codes = await this.syncCadences(dto.provider, dto.name, dto.currency, [
        {
          cadence: 'monthly',
          interval: BillingInterval.MONTHLY,
          amountMinor: this.toMinor(dto.monthlyPrice),
          durationDays: dto.monthlyDurationDays ?? 30,
        },
        {
          cadence: 'six_month',
          interval: BillingInterval.SIX_MONTH,
          amountMinor: this.toMinor(dto.sixMonthPrice ?? 0),
          durationDays: dto.sixMonthDurationDays ?? 180,
        },
        {
          cadence: 'annual',
          interval: BillingInterval.ANNUAL,
          amountMinor: this.toMinor(dto.annualPrice ?? 0),
          durationDays: dto.annualDurationDays ?? 365,
        },
      ]);
    }

    const created = await this.dataSource.transaction(async (trx) => {
      if (dto.isDefault) {
        // Scope the demotion to the SAME (account, level) slot. The
        // catalogue holds one default per (country, account, level)
        // slot — six slots per country — so a blanket "demote every
        // default in this country" would clobber the other five
        // unrelated defaults. The partial unique index
        // `subscription_plans_default_per_slot_uq` enforces at most one
        // default per slot, but this scoped update is what keeps the
        // OTHER slots' defaults intact when a new default is created
        // for one of them.
        await trx
          .createQueryBuilder()
          .update(SubscriptionPlanEntity)
          .set({ isDefault: false })
          .where(
            'country_code = :cc AND account = :account AND level = :level AND is_default = true',
            {
              cc: dto.countryCode,
              account: dto.account,
              level: dto.level,
            },
          )
          .execute();
      }

      const plan = trx.getRepository(SubscriptionPlanEntity).create({
        name: dto.name,
        description: dto.description ?? null,
        countryCode: dto.countryCode,
        currency: dto.currency,
        provider: dto.provider,
        account: dto.account,
        level: dto.level,
        paymentKind: dto.paymentKind,
        vatRatePct: dto.vatRatePct ?? 0,
        monthlyPrice: dto.monthlyPrice,
        // Catalogue invariant: one-time plans store 0 for cadence prices
        // they don't use, never NULL — keeps numeric math on listing
        // queries safe.
        sixMonthPrice: isOneTime ? 0 : (dto.sixMonthPrice as number),
        annualPrice: isOneTime ? 0 : (dto.annualPrice as number),
        monthlyDurationDays: dto.monthlyDurationDays ?? 30,
        sixMonthDurationDays: dto.sixMonthDurationDays ?? 180,
        annualDurationDays: dto.annualDurationDays ?? 365,
        providerPlanMonthly: codes.monthly,
        providerPlanSixMonth: codes.sixMonth,
        providerPlanAnnual: codes.annual,
        isActive: true,
        isDefault: dto.isDefault ?? false,
        version: 1,
        parentPlanId: null,
        createdBy: adminId,
      });
      return trx.getRepository(SubscriptionPlanEntity).save(plan);
    });

    await this.writeAudit(adminId, 'subscription_plan.create', created.id, {
      oldValue: null,
      newValue: this.snapshot(created),
    });
    return created;
  }

  // --- Update (cosmetic vs versioned) ---------------------------------------

  async update(
    adminId: string,
    id: string,
    dto: UpdatePlanDto,
  ): Promise<SubscriptionPlanEntity> {
    const current = await this.getById(id);
    if (!current.isActive) {
      throw new BadRequestException(
        'Archived plans cannot be edited. Use POST /admin/plans/:id/rollback to restore, or create a new plan.',
      );
    }

    const structural = this.detectStructuralChanges(current, dto);

    if (structural.length === 0) {
      return this.applyCosmetic(adminId, current, dto);
    }
    return this.versionBump(adminId, current, dto, structural);
  }

  /**
   * In-place update. Touches only name/description/isActive/isDefault, and
   * does NOT call the provider. Cosmetic changes are safe to overwrite the
   * same row — no pricing invariant is at stake.
   */
  private async applyCosmetic(
    adminId: string,
    current: SubscriptionPlanEntity,
    dto: UpdatePlanDto,
  ): Promise<SubscriptionPlanEntity> {
    const before = this.snapshot(current);

    const updated = await this.dataSource.transaction(async (trx) => {
      if (dto.isDefault === true) {
        // Slot-scoped: only demote OTHER defaults in the same
        // (country, account, level) trio — leave the five other slots'
        // defaults alone. See `versionBump` / `create` for the same
        // pattern.
        await trx
          .createQueryBuilder()
          .update(SubscriptionPlanEntity)
          .set({ isDefault: false })
          .where(
            'country_code = :cc AND account = :account AND level = :level AND id != :id AND is_default = true',
            {
              cc: current.countryCode,
              account: current.account,
              level: current.level,
              id: current.id,
            },
          )
          .execute();
      }
      await trx.getRepository(SubscriptionPlanEntity).update(current.id, {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
        // VAT rate is a display-only attribute (drives how the receipt
        // PDF breaks the gross price into net + tax). Adjusting it does
        // NOT need a version bump because no charged amount or contract
        // term is changing — only how the existing gross is annotated.
        ...(dto.vatRatePct !== undefined ? { vatRatePct: dto.vatRatePct } : {}),
      });
      return trx
        .getRepository(SubscriptionPlanEntity)
        .findOneOrFail({ where: { id: current.id } });
    });

    await this.writeAudit(
      adminId,
      'subscription_plan.update_cosmetic',
      current.id,
      { oldValue: before, newValue: this.snapshot(updated) },
    );
    return updated;
  }

  /**
   * Price or duration changed → insert a new version row, deactivate the
   * previous one. For each cadence that actually changed, call the provider
   * to create a fresh plan code. Cadences that didn't change carry their
   * code forward — no provider call, no dashboard clutter.
   */
  private async versionBump(
    adminId: string,
    current: SubscriptionPlanEntity,
    dto: UpdatePlanDto,
    changedCadences: ('monthly' | 'six_month' | 'annual')[],
  ): Promise<SubscriptionPlanEntity> {
    // Plan price columns now flow as JS numbers via the entity-level
    // NumericColumnTransformer, so no string→number coercion is needed
    // when falling back to current values. Previously this used
    // Number(current.X) because TypeORM returned strings.
    const monthlyPrice = dto.monthlyPrice ?? current.monthlyPrice;
    const sixMonthPrice = dto.sixMonthPrice ?? current.sixMonthPrice;
    const annualPrice = dto.annualPrice ?? current.annualPrice;
    const monthlyDurationDays =
      dto.monthlyDurationDays ?? current.monthlyDurationDays;
    const sixMonthDurationDays =
      dto.sixMonthDurationDays ?? current.sixMonthDurationDays;
    const annualDurationDays =
      dto.annualDurationDays ?? current.annualDurationDays;

    const toSync: CadencePricing[] = [];
    if (changedCadences.includes('monthly')) {
      toSync.push({
        cadence: 'monthly',
        interval: BillingInterval.MONTHLY,
        amountMinor: this.toMinor(monthlyPrice),
        durationDays: monthlyDurationDays,
      });
    }
    if (changedCadences.includes('six_month')) {
      toSync.push({
        cadence: 'six_month',
        interval: BillingInterval.SIX_MONTH,
        amountMinor: this.toMinor(sixMonthPrice),
        durationDays: sixMonthDurationDays,
      });
    }
    if (changedCadences.includes('annual')) {
      toSync.push({
        cadence: 'annual',
        interval: BillingInterval.ANNUAL,
        amountMinor: this.toMinor(annualPrice),
        durationDays: annualDurationDays,
      });
    }

    const nextName = dto.name ?? current.name;
    const freshCodes = await this.syncCadences(
      current.provider,
      this.versionedPlanName(nextName, current.version + 1),
      current.currency,
      toSync,
    );

    const providerPlanMonthly = changedCadences.includes('monthly')
      ? freshCodes.monthly
      : current.providerPlanMonthly;
    const providerPlanSixMonth = changedCadences.includes('six_month')
      ? freshCodes.sixMonth
      : current.providerPlanSixMonth;
    const providerPlanAnnual = changedCadences.includes('annual')
      ? freshCodes.annual
      : current.providerPlanAnnual;

    const before = this.snapshot(current);

    const graceHours =
      this.config.get<number>('paystack.checkoutGraceHours') ??
      parseInt(process.env.CHECKOUT_GRACE_HOURS ?? '48', 10);

    const next = await this.dataSource.transaction(async (trx) => {
      // Previous row enters a grace period (#73). It keeps isActive=true
      // so findByProviderPlanCode (called from the webhook handler)
      // can still resolve it for any Paystack authorizationUrl that
      // was issued before this bump and is still open. archive_at
      // marks WHEN the grace period ends; the public list filters
      // archived plans out so new subscribers only see v2. After
      // archive_at passes the row stays in the DB for audit but the
      // app treats it as unreachable.
      const archiveAt = new Date(Date.now() + graceHours * 60 * 60 * 1000);
      await trx.getRepository(SubscriptionPlanEntity).update(current.id, {
        archiveAt,
        // Default flips immediately so the pricing page shows v2 right
        // away; the grace period is for in-flight checkout completion,
        // not for keeping the old price visible to new shoppers.
        isDefault: false,
      });

      const promoted =
        dto.isDefault !== undefined ? dto.isDefault : current.isDefault;
      if (promoted) {
        // Demote ONLY the prior default in the same (account, level)
        // slot. The catalogue now has six default slots per country
        // (Plus × {BECE,WASSCE,NOVDEC} + Pro × {BECE,WASSCE,NOVDEC});
        // a blanket "demote every default in this country" would have
        // wiped out five unrelated defaults whenever an admin bumped a
        // single plan's price. The partial unique index
        // `subscription_plans_default_per_slot_uq` still guarantees at
        // most one default per slot — this scoped update keeps the
        // other slots untouched.
        await trx
          .createQueryBuilder()
          .update(SubscriptionPlanEntity)
          .set({ isDefault: false })
          .where(
            'country_code = :cc AND account = :account AND level = :level AND is_default = true',
            {
              cc: current.countryCode,
              account: current.account,
              level: current.level,
            },
          )
          .execute();
      }

      const created = trx.getRepository(SubscriptionPlanEntity).create({
        name: nextName,
        description:
          dto.description !== undefined ? dto.description : current.description,
        countryCode: current.countryCode,
        currency: current.currency,
        provider: current.provider,
        // Carry forward the account / level / payment_kind invariants —
        // a version bump never changes the slot a plan occupies. To move
        // a plan to a different (account, level) slot, admin must create
        // a new plan from scratch.
        account: current.account,
        level: current.level,
        paymentKind: current.paymentKind,
        vatRatePct:
          dto.vatRatePct !== undefined ? dto.vatRatePct : current.vatRatePct,
        monthlyPrice,
        sixMonthPrice,
        annualPrice,
        monthlyDurationDays,
        sixMonthDurationDays,
        annualDurationDays,
        providerPlanMonthly,
        providerPlanSixMonth,
        providerPlanAnnual,
        isActive: dto.isActive ?? true,
        isDefault: promoted,
        version: current.version + 1,
        parentPlanId: current.id,
        createdBy: adminId,
      });
      return trx.getRepository(SubscriptionPlanEntity).save(created);
    });

    await this.writeAudit(adminId, 'subscription_plan.version_bump', next.id, {
      oldValue: before,
      newValue: this.snapshot(next),
    });
    return next;
  }

  // --- Soft delete / sync / set-default / rollback ---------------------------

  async softDelete(
    adminId: string,
    id: string,
  ): Promise<SubscriptionPlanEntity> {
    const plan = await this.getById(id);
    if (!plan.isActive) return plan;
    const before = this.snapshot(plan);
    plan.isActive = false;
    plan.isDefault = false;
    const saved = await this.plansRepo.save(plan);
    await this.writeAudit(adminId, 'subscription_plan.deactivate', id, {
      oldValue: before,
      newValue: this.snapshot(saved),
    });
    return saved;
  }

  /**
   * Create missing provider plan codes for a plan. Useful when a plan was
   * created with syncProvider=false (e.g. local dev without credentials) or
   * when a prior sync partially failed.
   */
  async syncWithProvider(
    adminId: string,
    id: string,
  ): Promise<SubscriptionPlanEntity> {
    const plan = await this.getById(id);

    // One-time (Plus) plans don't carry provider plan codes — they
    // charge as single Paystack transactions. Calling sync would create
    // three useless Paystack `plan` objects (priced at 0 because
    // sixMonth/annual columns are 0 on Plus rows) and never use them.
    // Reject so the admin UI / curl call gets a clear signal.
    if (plan.paymentKind === PaymentKind.ONE_TIME) {
      throw new BadRequestException(
        'One-time (Plus) plans do not use provider plan codes — they charge as single transactions. Nothing to sync.',
      );
    }

    const toSync: CadencePricing[] = [];
    if (!plan.providerPlanMonthly) {
      toSync.push({
        cadence: 'monthly',
        interval: BillingInterval.MONTHLY,
        amountMinor: this.toMinor(plan.monthlyPrice),
        durationDays: plan.monthlyDurationDays,
      });
    }
    if (!plan.providerPlanSixMonth) {
      toSync.push({
        cadence: 'six_month',
        interval: BillingInterval.SIX_MONTH,
        amountMinor: this.toMinor(plan.sixMonthPrice),
        durationDays: plan.sixMonthDurationDays,
      });
    }
    if (!plan.providerPlanAnnual) {
      toSync.push({
        cadence: 'annual',
        interval: BillingInterval.ANNUAL,
        amountMinor: this.toMinor(plan.annualPrice),
        durationDays: plan.annualDurationDays,
      });
    }

    if (toSync.length === 0) {
      return plan;
    }

    const fresh = await this.syncCadences(
      plan.provider,
      this.versionedPlanName(plan.name, plan.version),
      plan.currency,
      toSync,
    );

    const before = this.snapshot(plan);
    if (!plan.providerPlanMonthly && fresh.monthly) {
      plan.providerPlanMonthly = fresh.monthly;
    }
    if (!plan.providerPlanSixMonth && fresh.sixMonth) {
      plan.providerPlanSixMonth = fresh.sixMonth;
    }
    if (!plan.providerPlanAnnual && fresh.annual) {
      plan.providerPlanAnnual = fresh.annual;
    }
    const saved = await this.plansRepo.save(plan);

    await this.writeAudit(adminId, 'subscription_plan.sync', id, {
      oldValue: before,
      newValue: this.snapshot(saved),
    });
    return saved;
  }

  async setDefault(
    adminId: string,
    id: string,
  ): Promise<SubscriptionPlanEntity> {
    const plan = await this.getById(id);
    if (!plan.isActive) {
      throw new BadRequestException(
        'Cannot set an archived plan as default. Roll back first.',
      );
    }

    const updated = await this.dataSource.transaction(async (trx) => {
      // Slot-scoped: demote any other default in the same
      // (country, account, level) trio, NOT all defaults in the country.
      // The catalogue has six slots per country and each can have one
      // default — this row owns its slot.
      await trx
        .createQueryBuilder()
        .update(SubscriptionPlanEntity)
        .set({ isDefault: false })
        .where(
          'country_code = :cc AND account = :account AND level = :level AND is_default = true AND id != :id',
          {
            cc: plan.countryCode,
            account: plan.account,
            level: plan.level,
            id: plan.id,
          },
        )
        .execute();
      await trx
        .getRepository(SubscriptionPlanEntity)
        .update(plan.id, { isDefault: true });
      return trx
        .getRepository(SubscriptionPlanEntity)
        .findOneOrFail({ where: { id: plan.id } });
    });

    await this.writeAudit(adminId, 'subscription_plan.set_default', id, {
      oldValue: this.snapshot(plan),
      newValue: this.snapshot(updated),
    });
    return updated;
  }

  /**
   * Revert to an archived version: flip the target `is_active=true`, and
   * the currently-active sibling of the same country `is_active=false`.
   * No provider calls — the old plan codes are preserved in the archive row.
   */
  async rollbackTo(
    adminId: string,
    id: string,
  ): Promise<SubscriptionPlanEntity> {
    const target = await this.getById(id);
    if (target.isActive) {
      throw new ConflictException('Plan is already active.');
    }
    // Recurring (Pro) plans need ALL three Paystack codes so the checkout
    // cadence selector works. One-time (Plus) plans NEVER have codes —
    // they charge a single transaction at checkout, so requiring codes
    // here would make Plus rollback always fail. Branch on payment_kind.
    if (target.paymentKind === PaymentKind.RECURRING) {
      if (
        !target.providerPlanMonthly ||
        !target.providerPlanSixMonth ||
        !target.providerPlanAnnual
      ) {
        throw new BadRequestException(
          'This version is missing provider plan codes. Run sync first.',
        );
      }
    }

    const updated = await this.dataSource.transaction(async (trx) => {
      // Deactivate the currently-active sibling in the SAME slot
      // (country, account, level). A blanket "deactivate every active
      // plan in this country" would have wiped out the other five slots'
      // active plans when rolling back any single slot.
      await trx
        .createQueryBuilder()
        .update(SubscriptionPlanEntity)
        .set({ isActive: false, isDefault: false })
        .where(
          'country_code = :cc AND account = :account AND level = :level AND is_active = true AND id != :id',
          {
            cc: target.countryCode,
            account: target.account,
            level: target.level,
            id: target.id,
          },
        )
        .execute();
      await trx.getRepository(SubscriptionPlanEntity).update(target.id, {
        isActive: true,
        isDefault: target.isDefault,
      });
      return trx
        .getRepository(SubscriptionPlanEntity)
        .findOneOrFail({ where: { id: target.id } });
    });

    await this.writeAudit(adminId, 'subscription_plan.rollback', id, {
      oldValue: this.snapshot(target),
      newValue: this.snapshot(updated),
    });
    return updated;
  }

  // --- Cadence view helpers (used by SubscriptionsService) ------------------

  cadenceFor(
    plan: SubscriptionPlanEntity,
    interval: BillingInterval,
  ): {
    amountMinor: number;
    amountDisplay: number;
    durationDays: number;
    providerPlanCode: string | null;
  } {
    switch (interval) {
      case BillingInterval.MONTHLY:
        return {
          amountMinor: this.toMinor(plan.monthlyPrice),
          amountDisplay: plan.monthlyPrice,
          durationDays: plan.monthlyDurationDays,
          providerPlanCode: plan.providerPlanMonthly,
        };
      case BillingInterval.SIX_MONTH:
        return {
          amountMinor: this.toMinor(plan.sixMonthPrice),
          amountDisplay: plan.sixMonthPrice,
          durationDays: plan.sixMonthDurationDays,
          providerPlanCode: plan.providerPlanSixMonth,
        };
      case BillingInterval.ANNUAL:
        return {
          amountMinor: this.toMinor(plan.annualPrice),
          amountDisplay: plan.annualPrice,
          durationDays: plan.annualDurationDays,
          providerPlanCode: plan.providerPlanAnnual,
        };
    }
  }

  findByProviderPlanCode(
    providerPlanCode: string,
  ): Promise<SubscriptionPlanEntity | null> {
    return this.plansRepo
      .createQueryBuilder('p')
      .where(
        'p.provider_plan_monthly = :code OR p.provider_plan_six_month = :code OR p.provider_plan_annual = :code',
        { code: providerPlanCode },
      )
      .getOne();
  }

  intervalForProviderPlanCode(
    plan: SubscriptionPlanEntity,
    providerPlanCode: string,
  ): BillingInterval | null {
    if (plan.providerPlanMonthly === providerPlanCode)
      return BillingInterval.MONTHLY;
    if (plan.providerPlanSixMonth === providerPlanCode)
      return BillingInterval.SIX_MONTH;
    if (plan.providerPlanAnnual === providerPlanCode)
      return BillingInterval.ANNUAL;
    return null;
  }

  // --- Internals -------------------------------------------------------------

  private detectStructuralChanges(
    current: SubscriptionPlanEntity,
    dto: UpdatePlanDto,
  ): ('monthly' | 'six_month' | 'annual')[] {
    const changed: ('monthly' | 'six_month' | 'annual')[] = [];
    if (
      dto.monthlyPrice !== undefined &&
      current.monthlyPrice !== dto.monthlyPrice
    ) {
      changed.push('monthly');
    }
    if (
      dto.sixMonthPrice !== undefined &&
      current.sixMonthPrice !== dto.sixMonthPrice
    ) {
      changed.push('six_month');
    }
    if (
      dto.annualPrice !== undefined &&
      current.annualPrice !== dto.annualPrice
    ) {
      changed.push('annual');
    }
    if (
      dto.monthlyDurationDays !== undefined &&
      current.monthlyDurationDays !== dto.monthlyDurationDays &&
      !changed.includes('monthly')
    ) {
      changed.push('monthly');
    }
    if (
      dto.sixMonthDurationDays !== undefined &&
      current.sixMonthDurationDays !== dto.sixMonthDurationDays &&
      !changed.includes('six_month')
    ) {
      changed.push('six_month');
    }
    if (
      dto.annualDurationDays !== undefined &&
      current.annualDurationDays !== dto.annualDurationDays &&
      !changed.includes('annual')
    ) {
      changed.push('annual');
    }
    return changed;
  }

  private async syncCadences(
    providerName: string,
    planNameBase: string,
    currency: string,
    cadences: CadencePricing[],
  ): Promise<{
    monthly: string | null;
    sixMonth: string | null;
    annual: string | null;
  }> {
    const provider = this.providers.get(providerName);
    const out: {
      monthly: string | null;
      sixMonth: string | null;
      annual: string | null;
    } = { monthly: null, sixMonth: null, annual: null };

    for (const c of cadences) {
      try {
        const created = await provider.createPlan({
          name: `${planNameBase} • ${c.cadence}`,
          amountMinor: c.amountMinor,
          currency,
          interval: c.interval,
        });
        if (c.cadence === 'monthly') out.monthly = created.providerPlanCode;
        if (c.cadence === 'six_month') out.sixMonth = created.providerPlanCode;
        if (c.cadence === 'annual') out.annual = created.providerPlanCode;
      } catch (err) {
        // Do not abort the whole create — an admin can retry via POST .../sync
        // to fill the gap. Log loudly so ops notices.
        this.logger.error(
          `[plans] ${providerName} createPlan failed for ${c.cadence}: ${(err as Error).message}`,
        );
      }
    }
    return out;
  }

  private toMinor(display: number): number {
    return Math.round(display * 100);
  }

  private versionedPlanName(base: string, version: number): string {
    return `${base} v${version}`;
  }

  private snapshot(plan: SubscriptionPlanEntity): Record<string, unknown> {
    return {
      id: plan.id,
      name: plan.name,
      countryCode: plan.countryCode,
      currency: plan.currency,
      provider: plan.provider,
      monthlyPrice: plan.monthlyPrice,
      sixMonthPrice: plan.sixMonthPrice,
      annualPrice: plan.annualPrice,
      monthlyDurationDays: plan.monthlyDurationDays,
      sixMonthDurationDays: plan.sixMonthDurationDays,
      annualDurationDays: plan.annualDurationDays,
      providerPlanMonthly: plan.providerPlanMonthly,
      providerPlanSixMonth: plan.providerPlanSixMonth,
      providerPlanAnnual: plan.providerPlanAnnual,
      isActive: plan.isActive,
      isDefault: plan.isDefault,
      version: plan.version,
      parentPlanId: plan.parentPlanId,
    };
  }

  private async writeAudit(
    adminId: string,
    action: string,
    entityId: string,
    values: {
      oldValue: Record<string, unknown> | null;
      newValue: Record<string, unknown>;
    },
  ): Promise<void> {
    try {
      await this.auditRepo.save(
        this.auditRepo.create({
          adminId,
          action,
          entityType: 'subscription_plan',
          entityId,
          oldValue: values.oldValue,
          newValue: values.newValue,
        }),
      );
    } catch (err) {
      this.logger.warn(
        `audit_log insert for ${action} failed: ${(err as Error).message}`,
      );
    }
  }
}
