import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  BillingInterval,
  PaymentAttemptStatus,
  PaymentKind,
} from '../../common/types/enums';
import { User } from '../users/entities/user.entity';
import { PlansService } from '../subscriptions/plans/plans.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { SubscriptionPlanEntity } from '../subscriptions/plans/entities/subscription-plan.entity';
import { PaymentAttemptsService } from './payment-attempts.service';
import { PaymentProviderRegistry } from './providers/payment-provider.registry';

export interface ReconcileInput {
  reference: string;
  /** Override when the transaction metadata can't identify the user. */
  userId?: string;
  /** Override when the transaction metadata can't identify the plan. */
  planId?: string;
  /** Required for recurring plans when metadata carries no cadence. */
  interval?: BillingInterval;
}

export interface ReconcileResult {
  outcome: 'already_recorded' | 'verified_existing' | 'reconciled';
  reference: string;
  userId: string;
  planId: string | null;
  account: string | null;
  level: string | null;
  interval: BillingInterval | null;
  amountGhs: number | null;
}

/**
 * Admin repair tool for "money at Paystack, nothing in our books".
 *
 * The clean-record contract: reconciliation NEVER grants anything
 * directly. It (1) verifies the reference server-to-server with
 * Paystack, (2) synthesises the missing payment_attempt at the
 * CATALOGUE price, then (3) drives the exact same
 * `SubscriptionsService.verify` path every normal checkout uses — so
 * the subscription row, financial-audit ACTIVATION event (MRR), receipt
 * email, and payment history all come out identical to a payment that
 * had worked first time. verify() re-checks the paid amount against
 * the attempt, so a mismatched charge can never activate.
 *
 * Idempotent: a reference that already has a PAID+linked attempt
 * returns 'already_recorded' without touching anything; a PENDING or
 * unlinked attempt is pushed through verify ('verified_existing').
 */
@Injectable()
export class PaymentReconcileService {
  private readonly logger = new Logger(PaymentReconcileService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    private readonly paymentAttempts: PaymentAttemptsService,
    private readonly providers: PaymentProviderRegistry,
    private readonly subs: SubscriptionsService,
    private readonly plans: PlansService,
  ) {}

  async reconcile(
    adminId: string,
    input: ReconcileInput,
  ): Promise<ReconcileResult> {
    const reference = input.reference.trim();
    if (!reference) {
      throw new UnprocessableEntityException('Reference is required.');
    }

    // ---- Existing attempt: repair through the normal path. ----------
    const existing = await this.paymentAttempts.findByReference(reference);
    if (existing) {
      if (
        existing.status === PaymentAttemptStatus.PAID &&
        existing.subscriptionId
      ) {
        return this.result('already_recorded', reference, existing.userId, {
          planId: existing.planId,
          interval: existing.billingInterval ?? null,
          amountGhs: existing.amountMinor / 100,
        });
      }
      await this.subs.verify(existing.userId, reference);
      this.logger.log(
        `[reconcile] admin=${adminId} drove existing attempt ${existing.id} (${existing.status}) through verify ref=${reference}`,
      );
      return this.result('verified_existing', reference, existing.userId, {
        planId: existing.planId,
        interval: existing.billingInterval ?? null,
        amountGhs: existing.amountMinor / 100,
      });
    }

    // ---- Foreign reference: verify at Paystack first. ---------------
    const provider = this.providers.get('paystack');
    const tx = await provider.verifyTransaction(reference).catch(() => null);
    if (!tx) {
      throw new NotFoundException(
        'Paystack does not recognise this reference. Check for typos and that it belongs to the live integration.',
      );
    }
    if (tx.status !== 'success') {
      throw new ConflictException(
        `Transaction status at Paystack is '${tx.status}' — only successful charges can be reconciled.`,
      );
    }

    const raw = (tx.raw ?? {}) as Record<string, unknown>;
    const meta = (raw.metadata ?? {}) as Record<string, unknown>;
    const customer = (raw.customer ?? {}) as Record<string, unknown>;
    const customerEmail =
      typeof customer.email === 'string'
        ? customer.email.trim().toLowerCase()
        : null;

    // ---- Resolve the user: explicit > metadata > customer email. ----
    let userId: string | null = null;
    const candidateId =
      input.userId ?? (meta.userId as string | undefined) ?? null;
    if (candidateId) {
      const user = await this.usersRepo.findOne({
        where: { id: candidateId },
        select: ['id'],
      });
      userId = user?.id ?? null;
      if (input.userId && !userId) {
        throw new NotFoundException('Supplied userId does not exist.');
      }
    }
    if (!userId && customerEmail) {
      const user = await this.usersRepo.findOne({
        where: { email: customerEmail },
        select: ['id'],
      });
      userId = user?.id ?? null;
    }
    if (!userId) {
      throw new UnprocessableEntityException(
        `Could not identify the user (metadata carried none, no account matches ${customerEmail ?? 'the customer email'}). Retry with an explicit userId.`,
      );
    }

    // ---- Resolve the plan: explicit > metadata > plan code. ---------
    let plan: SubscriptionPlanEntity | null = null;
    const candidatePlanId =
      input.planId ?? (meta.planId as string | undefined) ?? null;
    if (candidatePlanId) {
      plan = await this.plans.getById(candidatePlanId).catch(() => null);
      if (input.planId && !plan) {
        throw new NotFoundException('Supplied planId does not exist.');
      }
    }
    if (!plan && tx.providerPlanCode) {
      plan = await this.plans.findByProviderPlanCode(tx.providerPlanCode);
    }
    if (!plan) {
      throw new UnprocessableEntityException(
        'Could not resolve the plan from the transaction. Retry with an explicit planId.',
      );
    }

    // ---- Resolve the cadence for recurring plans. --------------------
    const isOneTime = plan.paymentKind === PaymentKind.ONE_TIME;
    let interval: BillingInterval | null = null;
    if (!isOneTime) {
      const hint =
        input.interval ??
        (meta.interval as string | undefined) ??
        (meta.cadence as string | undefined) ??
        null;
      if (
        hint === BillingInterval.MONTHLY ||
        hint === BillingInterval.SIX_MONTH ||
        hint === BillingInterval.ANNUAL
      ) {
        interval = hint;
      } else {
        throw new UnprocessableEntityException(
          'Recurring plan needs a billing interval (monthly / six_month / annual). Retry with an explicit interval.',
        );
      }
    }

    // ---- Amount guard: catalogue price, exact. -----------------------
    // Friendly pre-check; SubscriptionsService.verify re-checks the
    // paid amount against the attempt under its advisory lock.
    const expectedGhs = isOneTime
      ? Number(plan.monthlyPrice)
      : interval === BillingInterval.MONTHLY
        ? Number(plan.monthlyPrice)
        : interval === BillingInterval.SIX_MONTH
          ? Number(plan.sixMonthPrice)
          : Number(plan.annualPrice);
    const expectedMinor = Math.round(expectedGhs * 100);
    if (!(expectedMinor > 0)) {
      throw new UnprocessableEntityException(
        'Catalogue price for this plan/interval is not positive — refusing to reconcile.',
      );
    }
    if (tx.amountMinor !== expectedMinor) {
      throw new ConflictException(
        `Paystack charged ${(tx.amountMinor / 100).toFixed(2)} but the catalogue price is ${(expectedMinor / 100).toFixed(2)} ${plan.currency}. Refusing to reconcile a mismatched amount.`,
      );
    }
    if (
      tx.currency &&
      plan.currency &&
      tx.currency.toUpperCase() !== plan.currency.toUpperCase()
    ) {
      throw new ConflictException(
        `Currency mismatch: Paystack says ${tx.currency}, plan is ${plan.currency}.`,
      );
    }

    // ---- Synthesise the attempt, then the normal verify path. -------
    await this.paymentAttempts.createPending({
      userId,
      planId: plan.id,
      billingInterval: interval,
      amountMinor: expectedMinor,
      amountGhs: expectedMinor / 100,
      currency: plan.currency,
      provider: 'paystack',
      providerReference: reference,
      metadata: {
        source: 'admin_reconcile',
        reconciledByAdminId: adminId,
        account: plan.account,
        level: plan.level,
        paymentKind: plan.paymentKind,
      },
    });
    await this.subs.verify(userId, reference);

    this.logger.log(
      `[reconcile] admin=${adminId} reconciled ref=${reference} → user=${userId} plan=${plan.id} interval=${interval ?? 'one_time'}`,
    );
    return this.result('reconciled', reference, userId, {
      planId: plan.id,
      account: plan.account,
      level: plan.level,
      interval,
      amountGhs: expectedMinor / 100,
    });
  }

  private result(
    outcome: ReconcileResult['outcome'],
    reference: string,
    userId: string,
    extra: Partial<ReconcileResult>,
  ): ReconcileResult {
    return {
      outcome,
      reference,
      userId,
      planId: extra.planId ?? null,
      account: extra.account ?? null,
      level: extra.level ?? null,
      interval: extra.interval ?? null,
      amountGhs: extra.amountGhs ?? null,
    };
  }
}
