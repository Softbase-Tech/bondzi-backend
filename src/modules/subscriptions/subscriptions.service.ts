import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { CacheKeys } from '../../common/utils/cache-keys.util';
import { RedisService } from '../../common/redis/redis.service';
import {
  AccountType,
  BillingInterval,
  ExamType,
  PaymentKind,
  SubscriptionStatus,
} from '../../common/types/enums';
import { PaymentProviderRegistry } from '../payments/providers/payment-provider.registry';
import { User } from '../users/entities/user.entity';
import { Subscription } from './entities/subscription.entity';
import { PlansService } from './plans/plans.service';
import { SubscriptionPlanEntity } from './plans/entities/subscription-plan.entity';
import { MailService } from '../mail/mail.service';
import { MailEvent } from '../mail/mail.types';
import { PromoCodesService } from '../promo-codes/promo-codes.service';

/**
 * Resolved entitlement for one (user, level) pair. Computed from the live
 * `subscriptions` rows joined against `subscription_plan`. Free is the
 * implicit default — no row required.
 */
export interface Entitlement {
  account: AccountType;
  expiresAt: Date | null;
  subscriptionId: string | null;
}

/**
 * Flat response shape for GET /subscriptions/me and the `subscription`
 * field of GET /auth/me. Pulls `account`, `level`, and `paymentKind` off
 * the joined SubscriptionPlan so the mobile gate (`isPro()`) and the
 * settings → subscription screen can render correctly even for one-time
 * (Plus) rows whose `billingInterval` is NULL.
 *
 * Kept as a separate type from the Subscription entity (vs. extending it)
 * so we can serialise the dates as ISO strings and surface the joined
 * plan fields without exposing the relation object verbatim.
 */
export interface MeSubscriptionView {
  id: string;
  userId: string;
  planId: string | null;
  billingInterval: BillingInterval | null;
  provider: string | null;
  providerReference: string | null;
  providerSubscriptionId: string | null;
  providerCustomerId: string | null;
  xpRedemptionId: string | null;
  amountGhs: string | null;
  countryCode: string;
  status: SubscriptionStatus;
  startsAt: string | null;
  expiresAt: string | null;
  createdAt?: string;
  updatedAt?: string;
  /** From joined plan; `'free'` for XP-credited / plan-less rows. */
  account: AccountType;
  /** From joined plan; `null` for XP-credited rows. */
  level: ExamType | null;
  /** From joined plan; `null` for XP-credited rows. */
  paymentKind: PaymentKind | null;
}

/**
 * Ordinal rank of an account, used to compare entitlements. Higher = more
 * access. Pro outranks Plus outranks Free. Used by `hasEntitlement` and
 * when resolving "what's the user's effective account on this level" when
 * multiple subscription rows exist (e.g. user holds Plus AND Pro on SHS —
 * effective is Pro until it expires, then drops to Plus).
 */
function accountRank(a: AccountType): number {
  switch (a) {
    case AccountType.PRO:
      return 2;
    case AccountType.PLUS:
      return 1;
    case AccountType.FREE:
    default:
      return 0;
  }
}

/**
 * Free entitlement constant — returned whenever no active Plus/Pro row
 * matches. Hoisted so we don't allocate a fresh object per Free user on
 * every paywall check (this is the hot path for unsubscribed sessions).
 */
const FREE_ENTITLEMENT: Entitlement = {
  account: AccountType.FREE,
  expiresAt: null,
  subscriptionId: null,
};

/** Tolerance for amount-match comparison (pesewas). Anything within 1 GHS is */
/** treated as a match — Paystack rounds and converts FX intermittently. */
const AMOUNT_MATCH_TOLERANCE_MINOR = 100;

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    @InjectRepository(Subscription)
    private readonly subsRepo: Repository<Subscription>,
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    private readonly plans: PlansService,
    private readonly providers: PaymentProviderRegistry,
    private readonly redis: RedisService,
    private readonly dataSource: DataSource,
    private readonly mail: MailService,
    private readonly promoCodes: PromoCodesService,
  ) {}

  /**
   * Returns whether the user has ANY active paid entitlement on ANY level
   * (Plus or Pro). Useful for cross-level boolean checks like "is this a
   * paying user at all".
   *
   * For per-level paywall checks (the common case under the new account
   * model), use `hasEntitlement(userId, level, minAccount)` or
   * `entitlementFor(userId, level)` instead — those respect the rule that
   * a Plus on SHS does NOT grant access on BECE or NOVDEC.
   */
  async hasActiveSubscription(userId: string): Promise<boolean> {
    const sub = await this.getActiveSubscription(userId);
    return sub !== null;
  }

  /**
   * Resolve the user's effective entitlement on a specific level. Returns
   * Free (the implicit default) if no active Plus/Pro row matches.
   *
   * Resolution rules (encoded in the SQL `ORDER BY`):
   *
   *   1. Filter to subscriptions for this user × this level (via the joined
   *      plan's `level`) that are currently active — status in
   *      (active, trial, xp_credited) AND (expires_at is NULL or > now()).
   *   2. Sort by account rank (pro > plus) so a user holding both Plus and
   *      Pro on the same level resolves to Pro until Pro expires.
   *   3. Break account ties on later expiry (NULLS FIRST — a lifetime Plus
   *      outranks any time-bounded grant of the same account).
   *
   * Caching: keyed per (userId, level) with a short TTL so a webhook /
   * cancel can invalidate quickly. The "no entitlement" case is also
   * cached (as Free) to avoid a DB hit per paywall check for unsubscribed
   * users.
   */
  async entitlementFor(userId: string, level: ExamType): Promise<Entitlement> {
    const cacheKey = CacheKeys.entitlement(userId, level);
    const cached = await this.redis.getJson<{
      account: AccountType;
      expiresAt: string | null;
      subscriptionId: string | null;
    }>(cacheKey);
    if (cached) {
      // Cached entitlements must be re-validated against wall-clock — a
      // Pro row cached at 23:59 could be expired by the time it's read.
      if (this.entitlementStillValid(cached.account, cached.expiresAt)) {
        return {
          account: cached.account,
          expiresAt: cached.expiresAt ? new Date(cached.expiresAt) : null,
          subscriptionId: cached.subscriptionId,
        };
      }
    }

    const row = await this.subsRepo
      .createQueryBuilder('s')
      .innerJoin(
        SubscriptionPlanEntity,
        'p',
        'p.id = s.plan_id AND p.level = :level',
        { level },
      )
      .where('s.user_id = :uid', { uid: userId })
      .andWhere("s.status IN ('active','trial','xp_credited')")
      .andWhere('(s.expires_at IS NULL OR s.expires_at > NOW())')
      .select([
        's.id AS id',
        's.expires_at AS expires_at',
        'p.account AS account',
      ])
      .orderBy(
        `CASE p.account WHEN 'pro' THEN 2 WHEN 'plus' THEN 1 ELSE 0 END`,
        'DESC',
      )
      // NULLS FIRST so a lifetime Plus (expires_at IS NULL) wins over a
      // time-bounded grant of the same account.
      .addOrderBy('s.expires_at', 'DESC', 'NULLS FIRST')
      .limit(1)
      .getRawOne<{
        id: string;
        expires_at: Date | null;
        account: AccountType;
      }>();

    const entitlement: Entitlement = row
      ? {
          account: row.account,
          expiresAt: row.expires_at,
          subscriptionId: row.id,
        }
      : FREE_ENTITLEMENT;

    // TTL is short — a refund or cancel invalidates per-level explicitly,
    // but if that path is ever missed we don't want a stale grant to
    // outlive its real expiry by more than a few minutes.
    await this.redis.setJson(
      cacheKey,
      {
        account: entitlement.account,
        expiresAt: entitlement.expiresAt?.toISOString() ?? null,
        subscriptionId: entitlement.subscriptionId,
      },
      600,
    );
    return entitlement;
  }

  /**
   * Shorthand for paywall gates: `true` if the user's entitlement on `level`
   * is at least `minAccount`. `minAccount = plus` covers "any paid plan on
   * this level"; `minAccount = pro` covers "Pro-only features like AI
   * tests / analytics".
   *
   * `level` is accepted as nullable for the pre-onboarding case (user has
   * a JWT but hasn't picked an exam type yet) — that path returns false
   * for any paid-account check, which is the safe default.
   */
  async hasEntitlement(
    userId: string,
    level: ExamType | null | undefined,
    minAccount: AccountType,
  ): Promise<boolean> {
    if (minAccount === AccountType.FREE) return true;
    if (!level) return false;
    const ent = await this.entitlementFor(userId, level);
    return accountRank(ent.account) >= accountRank(minAccount);
  }

  /**
   * Snapshot of the user's entitlement on every billable level. Mobile uses
   * this to paint the Plans screen with per-level "Current plan" badges
   * (e.g. WASSCE shows Plus while BECE / NOVDEC are still Free) without
   * having to call `entitlementFor` three times.
   *
   * Order is fixed (BECE → WASSCE → NOVDEC) so the client can render rows
   * in a stable order.
   */
  async entitlementsForAllLevels(
    userId: string,
  ): Promise<Array<{ level: ExamType } & Entitlement>> {
    const levels: ExamType[] = [
      ExamType.BECE,
      ExamType.WASSCE,
      ExamType.NOVDEC,
    ];
    const rows = await Promise.all(
      levels.map(async (level) => ({
        level,
        ...(await this.entitlementFor(userId, level)),
      })),
    );
    return rows;
  }

  /**
   * Invalidate the per-level entitlement cache for a user across ALL levels.
   * Called from payment-success / cancel / refund flows — we don't know
   * which level was affected up-front in some webhook paths (and even when
   * we do, it's cheaper to blast the 3 keys than to thread the level
   * through every code path).
   */
  async invalidateEntitlementCache(userId: string): Promise<void> {
    await Promise.all(
      Object.values(ExamType).map((level) =>
        this.redis.del(CacheKeys.entitlement(userId, level)),
      ),
    );
  }

  private entitlementStillValid(
    account: AccountType,
    expiresAtIso: string | null,
  ): boolean {
    if (account === AccountType.FREE) return true;
    if (!expiresAtIso) return true; // lifetime Plus
    return new Date(expiresAtIso).getTime() > Date.now();
  }

  async getActiveSubscription(userId: string): Promise<Subscription | null> {
    const cacheKey = CacheKeys.subscriptionStatus(userId);
    const cached = await this.redis.getJson<{
      id: string;
      status: SubscriptionStatus;
      expiresAt: string | null;
    }>(cacheKey);
    if (cached && this.isActive(cached.status, cached.expiresAt)) {
      const row = await this.subsRepo.findOne({ where: { id: cached.id } });
      if (
        row &&
        this.isActive(row.status, row.expiresAt?.toISOString() ?? null)
      ) {
        return row;
      }
    }
    const latest = await this.subsRepo
      .createQueryBuilder('s')
      .where('s.user_id = :uid', { uid: userId })
      .andWhere('(s.expires_at IS NULL OR s.expires_at > NOW())')
      .andWhere("s.status IN ('active','trial','xp_credited')")
      .orderBy('s.expires_at', 'DESC')
      .getOne();
    if (!latest) {
      await this.redis.setJson(
        cacheKey,
        { id: '', status: SubscriptionStatus.EXPIRED, expiresAt: null },
        600,
      );
      return null;
    }
    await this.redis.setJson(
      cacheKey,
      {
        id: latest.id,
        status: latest.status,
        expiresAt: latest.expiresAt?.toISOString() ?? null,
      },
      600,
    );
    return latest;
  }

  private isActive(
    status: SubscriptionStatus,
    expiresAtIso: string | null,
  ): boolean {
    if (
      status !== SubscriptionStatus.ACTIVE &&
      status !== SubscriptionStatus.TRIAL &&
      status !== SubscriptionStatus.XP_CREDITED
    ) {
      return false;
    }
    if (!expiresAtIso) return status === SubscriptionStatus.ACTIVE;
    return new Date(expiresAtIso).getTime() > Date.now();
  }

  async getMine(
    userId: string,
    level: ExamType | null,
  ): Promise<MeSubscriptionView | null> {
    // Resolve the user's CURRENT level from the database, not from the
    // JWT — the access token has a 15-minute TTL and bakes in the
    // examType at issue time, so a user who switched profiles via
    // PATCH /auth/me/exam-type would otherwise keep seeing their OLD
    // level's entitlement for up to 15 minutes. The caller still passes
    // the JWT-derived level as a hint (used when DB is unreachable),
    // but the DB read is the authoritative source.
    if (!level) {
      const user = await this.usersRepo.findOne({
        where: { id: userId },
        select: ['id', 'examType'],
      });
      level = user?.examType ?? null;
    } else {
      // Even when the caller supplied a level, verify the user's current
      // level still matches. If they switched profiles since the JWT was
      // minted, refresh from DB.
      const user = await this.usersRepo.findOne({
        where: { id: userId },
        select: ['id', 'examType'],
      });
      if (user?.examType && user.examType !== level) {
        level = user.examType;
      }
    }
    // Prefer the active grant on the user's CURRENT level. Without the
    // level filter a user with Plus on WASSCE who switched their profile
    // to NOVDEC would still see "active subscription" on the home
    // screen — but every gated NOVDEC route would 403, because the
    // entitlement is per-level. Mobile's isPro() depends on this
    // response, so the level scope here is what keeps the gate and the
    // UI in sync.
    //
    // If no current-level grant exists, fall back to the most recent
    // row (any level, any status) so the UI can render "your last
    // subscription was cancelled / expired on $level" rather than
    // hiding the entire subscription state.
    if (level) {
      const activeForLevel = await this.subsRepo
        .createQueryBuilder('s')
        .innerJoin(
          SubscriptionPlanEntity,
          'p',
          'p.id = s.plan_id AND p.level = :level',
          { level },
        )
        .where('s.user_id = :uid', { uid: userId })
        .andWhere("s.status IN ('active','trial','xp_credited')")
        .andWhere('(s.expires_at IS NULL OR s.expires_at > NOW())')
        .orderBy(
          `CASE p.account WHEN 'pro' THEN 2 WHEN 'plus' THEN 1 ELSE 0 END`,
          'DESC',
        )
        .addOrderBy('s.expires_at', 'DESC', 'NULLS FIRST')
        .limit(1)
        .getOne();
      if (activeForLevel) {
        const loaded = await this.subsRepo.findOne({
          where: { id: activeForLevel.id },
          relations: ['plan'],
        });
        if (loaded) return this.toMeView(loaded);
      }
      // Fallback for "show last subscription state" — RESTRICT to rows
      // on the current level. If we returned the latest cross-level row
      // here, an inactive cancellation on a different level would
      // surface as the user's "current" sub, but more dangerously an
      // ACTIVE Plus on another level would flip mobile's `isPro()` to
      // true on a level the user is functionally Free on. The fallback
      // must stay level-scoped.
      const latestForLevel = await this.subsRepo
        .createQueryBuilder('s')
        .innerJoin(
          SubscriptionPlanEntity,
          'p',
          'p.id = s.plan_id AND p.level = :level',
          { level },
        )
        .where('s.user_id = :uid', { uid: userId })
        .orderBy('s.created_at', 'DESC')
        .limit(1)
        .getOne();
      if (latestForLevel) {
        const loaded = await this.subsRepo.findOne({
          where: { id: latestForLevel.id },
          relations: ['plan'],
        });
        if (loaded) return this.toMeView(loaded);
      }
      return null;
    }
    // No level supplied (pre-onboarding user). Return whichever row is
    // most recent across all levels — there's no "current level" to
    // scope to yet.
    const latest = await this.subsRepo.findOne({
      where: { userId },
      order: { createdAt: 'DESC' },
      relations: ['plan'],
    });
    return latest ? this.toMeView(latest) : null;
  }

  /**
   * Flatten a Subscription entity into the shape the mobile / admin
   * clients expect. The joined plan's account / level / paymentKind are
   * surfaced so mobile gates (`isPro()`) and screens (Settings →
   * Subscription) can render correctly for Plus rows whose
   * `billingInterval` is NULL (one-time charges have no cadence).
   *
   * XP-credited and other plan-less rows return `account='free'` since
   * they aren't tied to a catalogue plan — the row's status flag
   * (`xp_credited`) is the truth signal in those cases, not the account.
   */
  private toMeView(row: Subscription): MeSubscriptionView {
    return {
      id: row.id,
      userId: row.userId,
      planId: row.planId,
      billingInterval: row.billingInterval,
      provider: row.provider,
      providerReference: row.providerReference,
      providerSubscriptionId: row.providerSubscriptionId,
      providerCustomerId: row.providerCustomerId,
      xpRedemptionId: row.xpRedemptionId,
      amountGhs: row.amountGhs,
      countryCode: row.countryCode,
      status: row.status,
      startsAt: row.startsAt ? row.startsAt.toISOString() : null,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      createdAt: row.createdAt ? row.createdAt.toISOString() : undefined,
      updatedAt: row.updatedAt ? row.updatedAt.toISOString() : undefined,
      account: row.plan?.account ?? AccountType.FREE,
      level: row.plan?.level ?? null,
      paymentKind: row.plan?.paymentKind ?? null,
    };
  }

  /**
   * Begin a Paystack checkout for the given plan. Handles both account
   * kinds:
   *
   *   - Recurring plans (Pro): `interval` is required; we resolve the
   *     plan's cadence + provider plan code, initialise a Paystack
   *     subscription via the same `initializeCheckout` endpoint, and write
   *     a PAST_DUE row whose `expires_at` is the would-be renewal date.
   *
   *   - One-time plans (Plus): `interval` MUST be null — Plus has no
   *     billing cadence. We charge `monthlyPrice` (the catalogue's
   *     headline price for one-time plans) as a single transaction; on
   *     success the row flips to ACTIVE with `expires_at = NULL`
   *     (lifetime). No Paystack subscription is created.
   */
  async initiate(
    userId: string,
    planId: string,
    interval: BillingInterval | null,
    opts: { promoCode?: string } = {},
  ): Promise<{
    authorizationUrl: string;
    reference: string;
    promoApplied?: { code: string; discountAmount: number };
  }> {
    const plan = await this.plans.getActiveForCheckout(planId);
    const isOneTime = plan.paymentKind === PaymentKind.ONE_TIME;

    if (isOneTime && interval) {
      throw new BadRequestException(
        'One-time (Plus) plans do not accept a billing interval.',
      );
    }
    if (!isOneTime && !interval) {
      throw new BadRequestException(
        'Recurring (Pro) plans require a billing interval.',
      );
    }

    const cadence = isOneTime
      ? null
      : this.plans.cadenceFor(plan, interval as BillingInterval);
    if (!isOneTime && !cadence?.providerPlanCode) {
      throw new ConflictException(
        `Plan '${plan.name}' has no provider code for ${interval}. Ask an admin to sync the plan.`,
      );
    }

    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user?.email) {
      throw new BadRequestException(
        'Email is required for checkout — add an email to your account first.',
      );
    }

    const provider = this.providers.get(plan.provider);
    const reference = `pm_${user.id.slice(0, 8)}_${Date.now()}_${randomUUID().slice(0, 8)}`;

    // For one-time charges we use the plan's `monthlyPrice` as the
    // headline price (the column is repurposed as the single Plus price —
    // the other two cadence columns stay 0/unused). Paystack treats a
    // call with no `plan` field as a one-shot transaction.
    let amountMinor = isOneTime
      ? Math.round(Number(plan.monthlyPrice) * 100)
      : cadence!.amountMinor;
    let amountDisplay = isOneTime
      ? Number(plan.monthlyPrice)
      : cadence!.amountDisplay;

    // Promo code (optional). The quote() helper validates scope, window,
    // exhaustion, and per-user prior redemption — returns null on any
    // failure so we surface a clean 400.
    let promoApplied: { codeId: string; code: string; discountAmount: number } | null =
      null;
    if (opts.promoCode) {
      const quote = await this.promoCodes.quote(
        opts.promoCode,
        plan,
        userId,
        amountDisplay,
      );
      if (!quote) {
        throw new BadRequestException(
          'Promo code is not valid for this plan, already used, expired, or exhausted.',
        );
      }
      promoApplied = {
        codeId: quote.code.id,
        code: quote.code.code,
        discountAmount: quote.discountAmount,
      };
      amountDisplay = Math.max(0, amountDisplay - quote.discountAmount);
      amountMinor = Math.round(amountDisplay * 100);
    }

    // Reject zero-amount checkouts: Paystack rejects 0-minor charges with
    // an opaque error and our `verify()` amount-tolerance check would
    // then pass any subsequent 0-paid result, granting premium for ₵0
    // via a 100% promo. For free grants, admin should issue a manual
    // entitlement via /admin/entitlements/grant instead.
    if (amountMinor <= 0) {
      throw new BadRequestException(
        'Discount reduces the price to zero. Apply a partial-discount code or have admin grant the entitlement manually.',
      );
    }

    const session = await provider.initializeCheckout({
      user: { id: user.id, email: user.email },
      providerPlanCode: isOneTime ? '' : cadence!.providerPlanCode!,
      amountMinor,
      currency: plan.currency,
      reference,
      metadata: {
        userId: user.id,
        planId: plan.id,
        interval: interval ?? null,
        paymentKind: plan.paymentKind,
        providerPlanCode: isOneTime ? null : cadence!.providerPlanCode,
      },
    });

    // CRITICAL: the pre-payment row must NOT be in any status that the
    // active-status checks treat as Pro. `TRIAL` + a future `expires_at`
    // is treated as fully active by both `getActiveSubscription` and
    // SubscriptionGuard — meaning the row created here would unlock the
    // full plan duration the instant `initiate` returns, with no
    // payment, just by tapping "Start with <plan>".
    //
    // `PAST_DUE` is in the enum already, sits outside the "active" set
    // in both the guard and the service query, and is the closest
    // existing status for "we owe a payment on this row before it
    // counts". Verify (below) or the webhook flips it to ACTIVE on
    // successful charge. `expires_at` stays at the would-be expiry for
    // recurring plans (informational only) and stays NULL for one-time
    // plans where lifetime is the contract.
    const pending = this.subsRepo.create({
      userId: user.id,
      planId: plan.id,
      billingInterval: interval,
      provider: plan.provider,
      status: SubscriptionStatus.PAST_DUE,
      providerReference: session.reference,
      amountGhs: amountDisplay.toFixed(2),
      startsAt: new Date(),
      expiresAt: isOneTime
        ? null
        : new Date(Date.now() + cadence!.durationDays * 86400 * 1000),
      countryCode: user.countryCode ?? plan.countryCode,
      // Stamp the promo code id NOW so even an abandoned checkout has
      // an audit trail of which code was attempted. Redemption ledger
      // insertion happens in verify() once the payment lands.
      promoCodeId: promoApplied?.codeId ?? null,
    });
    await this.subsRepo.save(pending);

    return {
      authorizationUrl: session.authorizationUrl,
      reference: session.reference,
      promoApplied: promoApplied
        ? {
            code: promoApplied.code,
            discountAmount: promoApplied.discountAmount,
          }
        : undefined,
    };
  }

  /**
   * Server-side verification after payment. Never trust the client on
   * "success" — always reconfirm with the provider AND that the amount
   * actually paid matches the plan we recorded at initiate time. Without
   * the amount check, a tampered low-amount payment that succeeds at
   * Paystack would still flip the row to ACTIVE for the full plan
   * duration.
   *
   * Idempotent: if the sub is already ACTIVE, we short-circuit instead
   * of re-hitting Paystack on spam-retries.
   */
  async verify(
    userId: string,
    reference: string,
  ): Promise<Subscription | MeSubscriptionView> {
    // Serialize verify against the webhook handler's `applyWebhookActivation`
    // (which acquires the same per-user lock). Without this, a Paystack
    // callback hitting /verify at the same moment as the charge.success
    // webhook can interleave their UPDATEs on the same row — both end up
    // ACTIVE, but `expires_at` is whichever path wrote last (each computes
    // its own value). The lock guarantees serial ordering so the row's
    // final state matches the path that actually owns the activation.
    return this.withUserAdvisoryLock(userId, () =>
      this.verifyLocked(userId, reference),
    );
  }

  private async verifyLocked(
    userId: string,
    reference: string,
  ): Promise<Subscription | MeSubscriptionView> {
    const sub = await this.subsRepo.findOne({
      where: { providerReference: reference },
    });
    if (!sub)
      throw new NotFoundException(
        'Subscription record not found for reference',
      );
    if (sub.userId !== userId)
      throw new ConflictException('Reference does not belong to user');
    if (!sub.provider) {
      throw new ConflictException(
        'Subscription has no provider — cannot verify.',
      );
    }

    // Short-circuit on already-verified to avoid spam-retries hitting
    // Paystack on every page refresh. The lock above guarantees that if
    // we read ACTIVE here, the webhook flow has already committed its
    // update, so the response carries the canonical state.
    if (sub.status === SubscriptionStatus.ACTIVE) {
      const reloaded = await this.subsRepo.findOne({
        where: { id: sub.id },
        relations: ['plan'],
      });
      return reloaded ? this.toMeView(reloaded) : sub;
    }

    const provider = this.providers.get(sub.provider);
    const result = await provider.verifyTransaction(reference);
    if (result.status !== 'success') {
      throw new ConflictException(
        `Provider verification returned status=${result.status}`,
      );
    }

    // CRITICAL: cross-check the amount Paystack actually charged against
    // the amount we recorded at initiate time. A tampered checkout that
    // somehow lowered the amount but still succeeded at Paystack
    // (proxied/replayed init request) would otherwise grant the full
    // plan window for a partial payment.
    if (sub.amountGhs !== null) {
      const expectedMinor = Math.round(parseFloat(sub.amountGhs) * 100);
      const paidMinor = result.amountMinor;
      if (
        !Number.isFinite(paidMinor) ||
        Math.abs(paidMinor - expectedMinor) > AMOUNT_MATCH_TOLERANCE_MINOR
      ) {
        this.logger.error(
          `[verify] amount mismatch ref=${reference} expected=${expectedMinor} paid=${paidMinor}`,
        );
        throw new ConflictException(
          'Amount paid does not match the subscription price.',
        );
      }
    }

    // Reset the clock to NOW on successful payment so the user gets the
    // full cadence duration starting from when they actually paid, not
    // from when they tapped "Start" (which could have been hours ago if
    // they backgrounded the app mid-checkout). Re-fetching the plan +
    // cadence is one extra query, which is fine — verify runs at most
    // once per checkout.
    if (sub.planId && sub.billingInterval) {
      try {
        const plan = await this.plans.getActiveForCheckout(sub.planId);
        const cadence = this.plans.cadenceFor(plan, sub.billingInterval);
        sub.startsAt = new Date();
        sub.expiresAt = new Date(
          Date.now() + cadence.durationDays * 86400 * 1000,
        );
      } catch (err) {
        // Plan was archived between initiate and verify? Honour the
        // already-stamped expires_at rather than refusing access to a
        // legitimately-paid user. Log so we can spot the edge case.
        this.logger.warn(
          `[verify] plan ${sub.planId} not resolvable for cadence reset (${(err as Error).message}); keeping initiate-time expiry`,
        );
      }
    } else if (sub.planId && !sub.billingInterval) {
      // One-time (Plus): no billing interval → lifetime grant. Stamp
      // start-of-life at NOW; expires_at stays NULL.
      sub.startsAt = new Date();
      sub.expiresAt = null;
    }

    sub.status = SubscriptionStatus.ACTIVE;
    if (result.customerId) sub.providerCustomerId = result.customerId;
    await this.subsRepo.save(sub);

    // If a promo code was attached at initiate time, record the
    // redemption now that the payment is confirmed. Bumping the
    // counter + ledger happens inside the service's own transaction,
    // so a duplicate verify (e.g. user double-tapped the success
    // callback) re-enters the unique (code, user) index and
    // gracefully returns — no double-counted code, no extra row.
    //
    // We re-derive the discount amount as (plan headline − amount paid)
    // rather than threading it from initiate(). Re-fetching the plan
    // once per verify is cheaper than another migration to add a
    // `discount_amount` column; and the calculation is invertible since
    // both sides are known.
    if (sub.promoCodeId && sub.planId) {
      const paid = sub.amountGhs ? parseFloat(sub.amountGhs) : 0;
      const plan = await this.plans
        .getActiveForCheckout(sub.planId)
        .catch(() => null);
      const planGross = plan
        ? sub.billingInterval
          ? this.plans.cadenceFor(plan, sub.billingInterval).amountDisplay
          : Number(plan.monthlyPrice)
        : paid;
      const discountAmount = Math.max(0, planGross - paid);
      await this.promoCodes
        .recordRedemption({
          codeId: sub.promoCodeId,
          userId: sub.userId,
          subscriptionId: sub.id,
          discountAmount,
          currency: plan?.currency ?? 'GHS',
        })
        .catch((err) => {
          // Promo bookkeeping failure must NOT block the user's premium
          // access — they paid; the entitlement should land. Log loudly
          // so we can reconcile manually if it ever fires.
          this.logger.error(
            `[verify] promo redemption write failed for sub=${sub.id} code=${sub.promoCodeId}: ${(err as Error).message}`,
          );
        });
    }

    await this.invalidateCache(userId);
    // Reload with the plan relation so the response carries
    // account/level/paymentKind. Without this, mobile's `mapSubscription`
    // would derive `plan='free'` for a freshly-verified Plus row (no
    // billingInterval, no joined account) — the user would be flagged
    // as Free until the next /subscriptions/me refresh.
    const reloaded = await this.subsRepo.findOne({
      where: { id: sub.id },
      relations: ['plan'],
    });
    return reloaded ? this.toMeView(reloaded) : sub;
  }

  async cancel(
    userId: string,
    level: ExamType | null = null,
  ): Promise<Subscription> {
    // Serialise against the webhook handler (which holds the same
    // per-user lock during `applyWebhookActivation` and the refund path
    // during `applyRefund`). Without this, a renewal webhook arriving
    // mid-cancel could either resurrect the row to ACTIVE or write to a
    // row the user has just asked to cancel.
    return this.withUserAdvisoryLock(userId, () =>
      this.cancelLocked(userId, level),
    );
  }

  private async cancelLocked(
    userId: string,
    level: ExamType | null,
  ): Promise<Subscription> {
    // Refresh the level from the DB. The JWT-supplied value can be up
    // to 15 minutes stale (token TTL); cancelling the wrong row would
    // be irreversible. We err on the side of the live DB value.
    {
      const user = await this.usersRepo.findOne({
        where: { id: userId },
        select: ['id', 'examType'],
      });
      if (user?.examType) level = user.examType;
    }
    // Widened from `status: ACTIVE` only. The previous shape returned
    // 404 for users on a TRIAL or XP_CREDITED row even though they had
    // active access — and the UI cancel button was visible to them.
    //
    // Per-level scoping: under the account model, a user can hold a Plus
    // on WASSCE and Pro on NOVDEC simultaneously. Cancel must target the
    // grant on the user's CURRENT level — otherwise a tap on the
    // NOVDEC cancellation button could cancel the WASSCE Plus. Without
    // a level, we fall back to the most-recent active row (mainly for
    // admin-side callers that don't have a user context).
    const qb = this.subsRepo
      .createQueryBuilder('s')
      .where('s.user_id = :uid', { uid: userId })
      .andWhere('s.status IN (:...statuses)', {
        statuses: [
          SubscriptionStatus.ACTIVE,
          SubscriptionStatus.TRIAL,
          SubscriptionStatus.XP_CREDITED,
        ],
      })
      .andWhere('(s.expires_at IS NULL OR s.expires_at > NOW())');
    if (level) {
      qb.innerJoin(
        SubscriptionPlanEntity,
        'p',
        'p.id = s.plan_id AND p.level = :level',
        { level },
      );
    }
    const sub = await qb.orderBy('s.created_at', 'DESC').getOne();
    if (!sub) throw new NotFoundException('No active subscription');

    if (sub.provider && sub.providerSubscriptionId) {
      try {
        const provider = this.providers.get(sub.provider);
        await provider.cancelSubscription({
          subscriptionId: sub.providerSubscriptionId,
          customerId: sub.providerCustomerId,
        });
      } catch (err) {
        this.logger.warn(
          `Provider cancelSubscription failed: ${(err as Error).message}`,
        );
      }
    }
    sub.status = SubscriptionStatus.CANCELLED;
    await this.subsRepo.save(sub);
    await this.invalidateCache(userId);

    // Cancellation confirmation email. Best-effort; mail.send swallows
    // errors. Only emails recurring (Pro) cancellations — Plus is
    // lifetime and "cancelling" it doesn't have a recurring-payment
    // context that makes sense to confirm.
    if (sub.planId && sub.expiresAt) {
      await this.dispatchCancellationEmail(sub).catch((err) =>
        this.logger.warn(
          `[mail] cancellation email dispatch failed: ${(err as Error).message}`,
        ),
      );
    }

    return sub;
  }

  private async dispatchCancellationEmail(sub: Subscription): Promise<void> {
    if (!sub.planId || !sub.expiresAt) return;
    const [user, plan] = await Promise.all([
      this.usersRepo.findOne({ where: { id: sub.userId } }),
      this.plans.getById(sub.planId).catch(() => null),
    ]);
    if (!user?.email || !plan) return;
    await this.mail.send(MailEvent.SUBSCRIPTION_CANCELLED, user.email, {
      recipientName: user.fullName ?? undefined,
      planName: plan.name,
      level: plan.level.toUpperCase(),
      accessUntil: sub.expiresAt,
    });
  }

  async invalidateCache(userId: string): Promise<void> {
    // Invalidate BOTH the legacy cross-level cache (read by
    // SubscriptionGuard for paywall gating) AND every per-level entitlement
    // cache. Per-level invalidation is wildcard across BECE/WASSCE/NOVDEC
    // — cheaper than threading the changed level through every payment
    // event handler.
    await this.redis.del(CacheKeys.subscriptionStatus(userId));
    await this.invalidateEntitlementCache(userId);
  }

  /**
   * Called by the webhook handler. All provider-specific shape translation
   * has already happened — we only see normalized fields.
   *
   * Serialised under a Postgres advisory lock keyed by `userId` so two
   * webhook deliveries arriving milliseconds apart for the same user can't
   * both fall through the `existing` lookup and create duplicate ACTIVE
   * rows. Combined with the unique partial index on
   * `(provider, provider_reference) WHERE provider_reference IS NOT NULL`,
   * this closes the duplicate-subscription race entirely.
   */
  async applyWebhookActivation(args: {
    userId: string;
    plan: SubscriptionPlanEntity;
    /** `null` for one-time (Plus) plans — they have no billing cadence. */
    interval: BillingInterval | null;
    providerReference?: string;
    providerSubscriptionId?: string;
    providerCustomerId?: string;
    amountDisplay?: number;
    /**
     * Explicit expiry override. For recurring plans, omitting this uses
     * the plan's cadence to compute the renewal date. For one-time plans,
     * this is IGNORED — Plus is lifetime by contract, expires_at stays
     * NULL regardless of what the caller passes.
     */
    expiresAt?: Date;
  }): Promise<void> {
    const isOneTime = args.plan.paymentKind === PaymentKind.ONE_TIME;
    if (isOneTime && args.interval) {
      throw new ConflictException(
        'One-time plans cannot carry a billing interval.',
      );
    }
    if (!isOneTime && !args.interval) {
      throw new ConflictException(
        'Recurring plans require a billing interval.',
      );
    }

    await this.withUserAdvisoryLock(args.userId, async () => {
      // Only match by provider_reference. The previous fallback —
      // "latest sub for this userId" when no reference was provided —
      // silently overwrote an XP_CREDITED row (with its `xp_redemption_id`
      // pointer) with paid-plan fields, destroying the audit lineage.
      // If we have no reference to match against, we INSERT a fresh row;
      // the unique `(provider, provider_reference)` index that does exist
      // on the column would have blocked the wrong-row UPDATE anyway.
      const existing = args.providerReference
        ? await this.subsRepo.findOne({
            where: { providerReference: args.providerReference },
          })
        : null;

      // One-time: no cadence, lifetime expiry (NULL). Recurring: compute
      // expiry from the plan's cadence for the given interval.
      const computedExpiry = isOneTime
        ? null
        : args.expiresAt ??
          new Date(
            Date.now() +
              this.plans.cadenceFor(args.plan, args.interval as BillingInterval)
                .durationDays *
                86400 *
                1000,
          );

      if (existing) {
        existing.status = SubscriptionStatus.ACTIVE;
        existing.planId = args.plan.id;
        existing.billingInterval = args.interval;
        existing.provider = args.plan.provider;
        if (args.providerSubscriptionId) {
          existing.providerSubscriptionId = args.providerSubscriptionId;
        }
        if (args.providerCustomerId) {
          existing.providerCustomerId = args.providerCustomerId;
        }
        if (args.amountDisplay !== undefined) {
          existing.amountGhs = args.amountDisplay.toFixed(2);
        }
        existing.expiresAt = computedExpiry;
        await this.subsRepo.save(existing);
      } else {
        const created = this.subsRepo.create({
          userId: args.userId,
          planId: args.plan.id,
          billingInterval: args.interval,
          provider: args.plan.provider,
          status: SubscriptionStatus.ACTIVE,
          providerReference: args.providerReference ?? null,
          providerSubscriptionId: args.providerSubscriptionId ?? null,
          providerCustomerId: args.providerCustomerId ?? null,
          amountGhs:
            args.amountDisplay !== undefined
              ? args.amountDisplay.toFixed(2)
              : null,
          startsAt: new Date(),
          expiresAt: computedExpiry,
          countryCode: args.plan.countryCode,
        });
        await this.subsRepo.save(created);
      }
    });
    await this.invalidateCache(args.userId);
  }

  /**
   * Update the status of a SINGLE subscription row (identified by id).
   * The previous shape `update({ userId }, ...)` was a multi-row UPDATE
   * that flipped EVERY historical subscription for the user — one
   * `subscription.disable` event would also cancel an active xp_credited
   * sub or an unrelated old paid sub. The webhook handler now always
   * looks up the specific row by `provider_subscription_id` /
   * `provider_reference` before calling this.
   */
  async applyWebhookStatus(
    subscriptionId: string,
    status: SubscriptionStatus,
  ): Promise<void> {
    const sub = await this.subsRepo.findOne({ where: { id: subscriptionId } });
    if (!sub) return;
    sub.status = status;
    await this.subsRepo.save(sub);
    await this.invalidateCache(sub.userId);
  }

  /**
   * Revoke the entitlement attached to a refunded transaction.
   *
   * Status flips to `REFUNDED`, which sits outside the active-status set
   * (`active`, `trial`, `xp_credited`) so the next entitlement lookup
   * resolves to Free for that level. The row is preserved (not deleted)
   * for audit + financial reconciliation — same row carries the original
   * `provider_reference`, `amount_ghs`, and timestamps that the refund
   * was issued against.
   *
   * Works uniformly for both account kinds:
   *   - Plus (one_time, expires_at=NULL): status flip alone strips access.
   *   - Pro (recurring, expires_at=Date): status flip strips access and
   *     also stops future renewals being recognised as the "latest sub"
   *     for this user × level.
   *
   * Returns the affected subscription so the webhook handler can dispatch
   * a refund-confirmation email + write a financial-event row from the
   * resolved userId/plan.
   */
  async applyRefund(reference: string): Promise<Subscription | null> {
    const sub = await this.subsRepo.findOne({
      where: { providerReference: reference },
    });
    if (!sub) return null;
    // Idempotency: a refund webhook can be re-delivered after success.
    // If we already flipped this row to REFUNDED, defensively invalidate
    // the cache anyway — if a race somehow repopulated it after the
    // first invalidate (e.g. a parallel paywall check landed between
    // save() and invalidate()), the replay clears it. The financial
    // event row stays single-write — that's idempotent via
    // `provider_event_id` upstream.
    if (sub.status === SubscriptionStatus.REFUNDED) {
      await this.invalidateCache(sub.userId);
      return sub;
    }
    sub.status = SubscriptionStatus.REFUNDED;
    await this.subsRepo.save(sub);
    await this.invalidateCache(sub.userId);
    return sub;
  }

  /**
   * Postgres advisory lock keyed by a 64-bit hash of the user id. Lock is
   * held for the duration of the callback only — released on commit or
   * abort. Used by webhook flows to serialise concurrent activations for
   * the same user; cheap (~100µs) and doesn't block other users.
   */
  private async withUserAdvisoryLock<T>(
    userId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (em) => {
      // pg_advisory_xact_lock takes a bigint; we derive one from the
      // first 8 bytes of a SHA-256 of the userId. Two-arg variant would
      // let us namespace, but the single-arg form keeps everything
      // inside one 64-bit space — collisions across hot users are
      // negligible and the worst case is two unrelated activations
      // serialising for ~10ms.
      const lockKey = this.advisoryLockKey(userId);
      await em.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);
      return fn();
    });
  }

  private advisoryLockKey(userId: string): string {
    const digest = createHash('sha256').update(userId).digest();
    // Take the first 8 bytes as a signed 64-bit integer (BigInt → string
    // because Postgres bigint is wider than JS Number can safely hold).
    const hi = BigInt(digest.readUInt32BE(0));
    const lo = BigInt(digest.readUInt32BE(4));
    const unsigned = (hi << 32n) | lo;
    // Postgres bigint is signed; reinterpret values >= 2^63 as negative.
    const signed = unsigned >= 1n << 63n ? unsigned - (1n << 64n) : unsigned;
    return signed.toString();
  }

  async findLatestByRef(reference: string): Promise<Subscription | null> {
    return this.subsRepo.findOne({ where: { providerReference: reference } });
  }

  async findLatestBySubscriptionId(
    providerSubscriptionId: string,
  ): Promise<Subscription | null> {
    return this.subsRepo.findOne({ where: { providerSubscriptionId } });
  }

  async findLatestByCustomer(
    providerCustomerId: string,
  ): Promise<Subscription | null> {
    return this.subsRepo.findOne({
      where: { providerCustomerId },
    });
  }

  async saveSubscription(sub: Subscription): Promise<Subscription> {
    return this.subsRepo.save(sub);
  }
}
