import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import { DataSource, In, Repository } from 'typeorm';
import { CacheKeys } from '../../common/utils/cache-keys.util';
import { RedisService } from '../../common/redis/redis.service';
import {
  AccountType,
  BillingInterval,
  ExamType,
  PaymentAttemptStatus,
  PaymentKind,
  SubscriptionStatus,
} from '../../common/types/enums';
import { PartnerCommissionsService } from '../partners/partner-commissions.service';
import { PaymentProviderRegistry } from '../payments/providers/payment-provider.registry';
import { User } from '../users/entities/user.entity';
import { Subscription } from './entities/subscription.entity';
import { PlansService } from './plans/plans.service';
import { SubscriptionPlanEntity } from './plans/entities/subscription-plan.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { MailService } from '../mail/mail.service';
import { MailEvent } from '../mail/mail.types';
import { PromoCodesService } from '../promo-codes/promo-codes.service';
import { PaymentAttemptsService } from '../payments/payment-attempts.service';
import { FinancialAuditService } from '../payments/financial-audit.service';
import { FinancialEventType } from '../payments/entities/financial-event.entity';
import { PaymentAttempt } from '../payments/entities/payment-attempt.entity';

/**
 * Resolved entitlement for one (user, level) pair. Computed from the live
 * `subscriptions` rows joined against `subscription_plan`. Free is the
 * implicit default — no row required.
 */
export interface Entitlement {
  account: AccountType;
  expiresAt: Date | null;
  subscriptionId: string | null;
  /**
   * True when the underlying subscription row has been cancelled but is
   * still within its prepaid grace period (`expires_at > NOW()`). The
   * user keeps Pro features until that date; no further billing will
   * happen. Mobile UI uses this flag to render "Cancelled — access ends
   * Mar 5" instead of "Renews Mar 5".
   *
   * Always `false` for Free, Plus (lifetime, no cancellation grace),
   * and currently-billing Pro.
   */
  cancelled: boolean;
  /**
   * True when the user holds an ACTIVE Plus subscription on this
   * level UNDERNEATH the currently-resolved Pro entitlement. Mobile
   * surfaces a one-line hint ("Plus stays after Pro ends") so a user
   * who layered Pro on top of a lifetime Plus knows their access
   * doesn't drop to Free when Pro lapses.
   *
   * Always `false` unless the resolved account is Pro AND a separate
   * Plus row exists on the same (user, level).
   */
  dormantPlusOnLevel: boolean;
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
  cancelled: false,
  dormantPlusOnLevel: false,
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
    @InjectRepository(Subject)
    private readonly subjectsRepo: Repository<Subject>,
    private readonly plans: PlansService,
    private readonly providers: PaymentProviderRegistry,
    private readonly redis: RedisService,
    private readonly dataSource: DataSource,
    private readonly mail: MailService,
    private readonly promoCodes: PromoCodesService,
    private readonly paymentAttempts: PaymentAttemptsService,
    private readonly partnerCommissions: PartnerCommissionsService,
    private readonly financialAudit: FinancialAuditService,
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
      cancelled?: boolean;
    }>(cacheKey);
    if (cached) {
      // Cached entitlements must be re-validated against wall-clock — a
      // Pro row cached at 23:59 could be expired by the time it's read.
      if (this.entitlementStillValid(cached.account, cached.expiresAt)) {
        return {
          account: cached.account,
          expiresAt: cached.expiresAt ? new Date(cached.expiresAt) : null,
          subscriptionId: cached.subscriptionId,
          // `cancelled` was added later — older cached entries default to
          // false (the common case for any cache miss-then-hit cycle).
          cancelled: cached.cancelled ?? false,
          dormantPlusOnLevel:
            (cached as { dormantPlusOnLevel?: boolean }).dormantPlusOnLevel ??
            false,
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
      // Industry-standard cancellation behaviour: the user keeps Pro
      // until the period they already paid for runs out. A row in
      // CANCELLED state with `expires_at > NOW()` is still on the
      // grant set — billing has stopped (Paystack cancel was called
      // when the user tapped Cancel), but the entitlement holds until
      // the prepaid period naturally lapses. The cancellation email
      // promises this; without the OR clause below the user would
      // lose Pro the instant they cancelled, contradicting the email.
      // EXPIRED, REFUNDED, PAST_DUE stay excluded — those represent
      // either a natural end-of-period or a money-back event.
      .andWhere(
        `(
          s.status IN ('active','trial','xp_credited')
          OR (s.status = 'cancelled' AND s.expires_at > NOW())
        )`,
      )
      .andWhere('(s.expires_at IS NULL OR s.expires_at > NOW())')
      .select([
        's.id AS id',
        's.status AS status',
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
        status: SubscriptionStatus;
        expires_at: Date | null;
        account: AccountType;
      }>();

    // Dormant-Plus probe: when the resolved entitlement is Pro,
    // check if there's a SEPARATE Plus row on the same level that
    // would remain after Pro lapses. Surfacing this lets the mobile
    // UI tell the user "Plus stays after Pro ends" instead of
    // implying they drop to Free at expiry. Plus is the implicit
    // floor under Pro for any user who layered both.
    let dormantPlusOnLevel = false;
    if (row && row.account === AccountType.PRO) {
      const dormant = await this.subsRepo
        .createQueryBuilder('s')
        .innerJoin(
          SubscriptionPlanEntity,
          'p',
          `p.id = s.plan_id AND p.level = :level AND p.account = 'plus'`,
          { level },
        )
        .where('s.user_id = :uid', { uid: userId })
        .andWhere(`s.status IN ('active','trial','xp_credited')`)
        .andWhere('(s.expires_at IS NULL OR s.expires_at > NOW())')
        .limit(1)
        .getOne();
      dormantPlusOnLevel = Boolean(dormant);
    }

    const entitlement: Entitlement = row
      ? {
          account: row.account,
          expiresAt: row.expires_at,
          subscriptionId: row.id,
          cancelled: row.status === SubscriptionStatus.CANCELLED,
          dormantPlusOnLevel,
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
        cancelled: entitlement.cancelled,
        dormantPlusOnLevel: entitlement.dormantPlusOnLevel,
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
   * Free users may practice core subjects only on a level. Plus or Pro
   * unlocks electives. No-op for core subjects; throws 403 for electives
   * when the user lacks a paid entitlement on `level`.
   */
  async assertCanStudySubject(
    userId: string,
    level: ExamType | null | undefined,
    subjectId: string,
  ): Promise<void> {
    if (!level) {
      throw new ForbiddenException(
        'Complete onboarding before accessing subjects.',
      );
    }
    const subject = await this.subjectsRepo.findOne({
      where: { id: subjectId },
    });
    if (!subject) throw new NotFoundException('Subject not found');
    if (subject.isCore) return;
    const ok = await this.hasEntitlement(userId, level, AccountType.PLUS);
    if (!ok) {
      throw new ForbiddenException(
        'Plus or Pro is required for elective subjects on this level.',
      );
    }
  }

  /**
   * Batch variant for exam filters that carry multiple subject ids.
   */
  async assertCanStudySubjects(
    userId: string,
    level: ExamType | null | undefined,
    subjectIds: string[] | undefined,
  ): Promise<void> {
    if (!subjectIds?.length) return;
    const subjects = await this.subjectsRepo.find({
      where: { id: In(subjectIds) },
      select: ['id', 'isCore'],
    });
    if (subjects.some((s) => !s.isCore)) {
      const ok = await this.hasEntitlement(
        userId,
        level ?? undefined,
        AccountType.PLUS,
      );
      if (!ok) {
        throw new ForbiddenException(
          'Plus or Pro is required for elective subjects on this level.',
        );
      }
    }
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

    // Double-pay guard: an existing row on the SAME (level, account,
    // billingInterval) that has not been REFUNDED or EXPIRED would
    // be hit by `consumePaidAttempt` post-payment. To avoid charging
    // the user's card and only THEN telling them it was a duplicate,
    // we mirror `consumePaidAttempt`'s exclusion list here at the
    // pre-charge boundary.
    //
    // For Plus this catches the cancel→rebuy case: a Plus row with
    // `status='cancelled'` and `expires_at IS NULL` would otherwise
    // slip past the legacy "active OR (cancelled AND expires_at >
    // NOW())" check, because `NULL > NOW()` is false. We now block
    // any non-refunded/non-expired Plus row regardless of status.
    const dupe = await this.subsRepo
      .createQueryBuilder('s')
      .innerJoin(
        SubscriptionPlanEntity,
        'p',
        'p.id = s.plan_id AND p.level = :level AND p.account = :account',
        { level: plan.level, account: plan.account },
      )
      .where('s.user_id = :uid', { uid: userId })
      .andWhere(`s.status NOT IN ('refunded','expired')`)
      // Past-grace rows (status='cancelled', expires_at < NOW(),
      // not yet swept to 'expired') must NOT block a legitimate
      // re-subscribe. The OR-NULL clause keeps Plus blocked
      // (lifetime Plus has expires_at IS NULL, so NULL passes) —
      // which is the right behaviour because Plus is not
      // cancellable in the first place. Past-grace Pro returns
      // false for both branches → query misses → re-subscribe
      // permitted.
      .andWhere('(s.expires_at IS NULL OR s.expires_at > NOW())')
      .andWhere(
        interval ? 's.billing_interval = :bi' : 's.billing_interval IS NULL',
        interval ? { bi: interval } : {},
      )
      .getOne();
    if (dupe) {
      throw new ConflictException(
        isOneTime
          ? 'You already own this Plus plan on this level.'
          : 'You already have this Pro cadence on this level. Cancel the current subscription before starting a new one.',
      );
    }

    // Plus-while-Pro guard: refuse to start a Plus checkout when the
    // user holds an active Pro on the same level. Without this, the
    // user pays a lump sum for the lifetime-Plus tier while Paystack
    // keeps auto-debiting Pro — they meant to downgrade, not stack
    // two tiers. Direct them to cancel Pro first (the cancellation
    // email + grace flow keeps their Pro access until the cycle ends,
    // then they can buy Plus cleanly).
    if (isOneTime) {
      const livePro = await this.subsRepo
        .createQueryBuilder('s')
        .innerJoin(
          SubscriptionPlanEntity,
          'p',
          'p.id = s.plan_id AND p.level = :level AND p.account = :account',
          { level: plan.level, account: AccountType.PRO },
        )
        .where('s.user_id = :uid', { uid: userId })
        .andWhere(`s.status IN ('active','trial','xp_credited')`)
        .andWhere('(s.expires_at IS NULL OR s.expires_at > NOW())')
        .getOne();
      if (livePro) {
        throw new ConflictException(
          'You currently have Pro on this level. Cancel Pro first, then buy Plus once the cycle ends — your Pro access continues until then.',
        );
      }
    }

    // Pending-attempt guard: the dupe check above lives on
    // `subscriptions`, but two rapid initiate() calls (mobile
    // double-tap, flaky network retry) both pass the subscription
    // check, both write pending payment_attempts rows, and both open
    // Paystack checkouts. We refuse if a same-(user, plan, interval)
    // attempt was initiated in the last 5 minutes and is still
    // PENDING — long enough to cover the user finishing the in-app
    // browser flow, short enough to forgive a genuine retry after
    // abandonment. Once initiate returns the existing reference the
    // mobile can re-open the same checkout.
    const recentPendingCutoff = new Date(Date.now() - 5 * 60 * 1000);
    const recentPending = await this.dataSource
      .getRepository(PaymentAttempt)
      .createQueryBuilder('pa')
      .where('pa.user_id = :uid', { uid: userId })
      .andWhere('pa.plan_id = :pid', { pid: plan.id })
      .andWhere('pa.status = :st', { st: PaymentAttemptStatus.PENDING })
      .andWhere(
        interval ? 'pa.billing_interval = :bi' : 'pa.billing_interval IS NULL',
        interval ? { bi: interval } : {},
      )
      .andWhere('pa.initiated_at > :since', { since: recentPendingCutoff })
      .orderBy('pa.initiated_at', 'DESC')
      .getOne();
    if (recentPending) {
      throw new ConflictException({
        code: 'CHECKOUT_IN_PROGRESS',
        message:
          'A checkout for this plan is already in progress. Complete or abandon the existing one before starting a new one.',
        reference: recentPending.providerReference,
      });
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
    let promoApplied: {
      codeId: string;
      code: string;
      discountAmount: number;
    } | null = null;
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

    // Persist the attempt BEFORE we hit the provider. The webhook
    // handler's trust model is "we must have initiated every payment
    // we accept" — without the row landing first, a webhook racing the
    // provider's response could arrive against a reference we don't yet
    // know about and trip the no_matching_payment alarm. The row's
    // status stays PENDING until verify() or the webhook flips it to
    // PAID; the abandoned sweeper picks up rows still pending after
    // 24h.
    await this.paymentAttempts.createPending({
      userId: user.id,
      planId: plan.id,
      billingInterval: interval,
      amountMinor,
      amountGhs: amountDisplay,
      currency: plan.currency,
      provider: plan.provider,
      providerReference: reference,
      promoCodeId: promoApplied?.codeId ?? null,
      discountAmount: promoApplied?.discountAmount ?? null,
      metadata: {
        account: plan.account,
        level: plan.level,
        paymentKind: plan.paymentKind,
        providerPlanCode: isOneTime ? null : cadence!.providerPlanCode,
        durationDays: isOneTime ? null : cadence!.durationDays,
        countryCode: user.countryCode ?? plan.countryCode,
      },
    });

    try {
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
    } catch (err) {
      // Provider call failed AFTER the attempt row was written — flip it
      // to failed so the user-facing payment history reflects the
      // outcome instead of dangling as pending forever (the abandoned
      // sweeper would eventually catch it, but the reason would be
      // wrong: "you abandoned this" vs. "the provider rejected this").
      await this.paymentAttempts
        .markFailedByReference(
          reference,
          err instanceof Error ? err.message : String(err),
        )
        .catch((flipErr) => {
          this.logger.error(
            `[subscriptions.initiate] failed to mark attempt ${reference} as failed: ${flipErr}`,
          );
        });
      throw err;
    }
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
  /**
   * Ledger write for a verify-path activation. Shares one
   * deterministic dedup key per charge (`activation:<reference>`)
   * with the webhook handler, so a payment yields exactly ONE
   * ACTIVATION row no matter which path activates first — the
   * financial ledger no longer depends on webhook delivery.
   * Best-effort: a ledger hiccup must never fail the user's verify.
   */
  private async recordActivationLedger(
    attempt: PaymentAttempt,
    plan: SubscriptionPlanEntity,
    subscriptionId: string | null,
  ): Promise<void> {
    try {
      await this.financialAudit.record({
        eventType: FinancialEventType.ACTIVATION,
        userId: attempt.userId,
        subscriptionId,
        amountMinor: attempt.amountMinor,
        currency: attempt.currency,
        source: 'verify',
        providerEventId: `activation:${attempt.providerReference}`,
        metadata: {
          provider: attempt.provider,
          providerReference: attempt.providerReference,
          planId: plan.id,
          interval: attempt.billingInterval ?? null,
          account: plan.account,
          level: plan.level,
          paymentKind: plan.paymentKind,
          isRenewal: false,
        },
      });
    } catch (err) {
      this.logger.warn(
        `[verify] activation ledger write failed ref=${attempt.providerReference}: ${(err as Error).message}`,
      );
    }
  }

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
    // NEW MODEL: the lookup key is the payment_attempt row — every
    // checkout we initiate writes one of these BEFORE Paystack is called.
    // A missing row here means the reference wasn't issued by us;
    // never trust the client to drive a fresh subscription off an
    // unknown ref.
    const attempt = await this.paymentAttempts.findByReference(reference);
    if (!attempt) {
      throw new NotFoundException('Payment attempt not found for reference');
    }
    if (attempt.userId !== userId) {
      throw new ConflictException('Reference does not belong to user');
    }

    // Idempotency: a previously-completed verify must return the
    // resolved subscription without re-hitting Paystack. The lock
    // above guarantees that if we read PAID here the webhook flow has
    // already committed its upsert.
    if (attempt.status === PaymentAttemptStatus.PAID) {
      if (attempt.subscriptionId) {
        const sub = await this.subsRepo.findOne({
          where: { id: attempt.subscriptionId },
          relations: ['plan'],
        });
        if (sub) return this.toMeView(sub);
      }
      // Paid attempt with no linked subscription — repair on read by
      // running the upsert. Rare (webhook activation crashed mid-flight,
      // or admin manually flipped status); we want a clean state by the
      // time the user lands on the success screen.
      if (!attempt.planId) {
        throw new ConflictException(
          'Payment attempt has no plan — cannot reconcile.',
        );
      }
      const plan = await this.plans.getActiveForCheckout(attempt.planId);
      const { subscription: repaired } = await this.consumePaidAttempt(
        attempt,
        plan,
      );
      await this.recordActivationLedger(attempt, plan, repaired.id);
      const reloaded = await this.subsRepo.findOne({
        where: { id: repaired.id },
        relations: ['plan'],
      });
      return reloaded ? this.toMeView(reloaded) : repaired;
    }

    if (attempt.status !== PaymentAttemptStatus.PENDING) {
      // FAILED / REFUNDED / ABANDONED — terminal. Don't resurrect.
      throw new ConflictException(
        `Payment attempt is ${attempt.status}; cannot verify.`,
      );
    }

    const provider = this.providers.get(attempt.provider);
    const result = await provider.verifyTransaction(reference);
    if (result.status !== 'success') {
      await this.paymentAttempts.markFailed(
        attempt.id,
        `Provider verification returned status=${result.status}`,
      );
      throw new ConflictException(
        `Provider verification returned status=${result.status}`,
      );
    }

    // CRITICAL: cross-check the amount Paystack actually charged
    // against what we recorded at initiate time. A tampered checkout
    // that lowered the amount but still succeeded at Paystack
    // (proxied/replayed init) would otherwise grant the full plan
    // window for a partial payment.
    const expectedMinor = attempt.amountMinor;
    const paidMinor = result.amountMinor;
    if (
      !Number.isFinite(paidMinor) ||
      Math.abs(paidMinor - expectedMinor) > AMOUNT_MATCH_TOLERANCE_MINOR
    ) {
      this.logger.error(
        `[verify] amount mismatch ref=${reference} expected=${expectedMinor} paid=${paidMinor}`,
      );
      throw new ConflictException(
        'Amount paid does not match the recorded price.',
      );
    }

    if (!attempt.planId) {
      throw new ConflictException(
        'Payment attempt has no plan — cannot resolve subscription.',
      );
    }
    const plan = await this.plans.getActiveForCheckout(attempt.planId);

    // Mark paid first; consumePaidAttempt will then read the freshly
    // updated row and link the subscription back.
    await this.paymentAttempts.markPaid(attempt.id, {
      providerCustomerId: result.customerId ?? null,
    });
    const refreshed = await this.paymentAttempts.findById(attempt.id);
    if (!refreshed) {
      throw new ConflictException('Payment attempt vanished after mark-paid.');
    }

    const { subscription } = await this.consumePaidAttempt(refreshed, plan, {
      providerCustomerId: result.customerId ?? undefined,
      amountDisplay: paidMinor / 100,
    });
    await this.recordActivationLedger(refreshed, plan, subscription.id);
    const reloaded = await this.subsRepo.findOne({
      where: { id: subscription.id },
      relations: ['plan'],
    });
    return reloaded ? this.toMeView(reloaded) : subscription;
  }

  /**
   * Apply a successful payment to the appropriate subscription.
   * Pure book-keeping — assumes the caller has already marked the
   * payment_attempt as PAID and validated the amount.
   *
   * Decision matrix (per the refactor brief):
   *
   *   Plus (one-time):
   *     - existing per-(user, level, account=plus) row?
   *         yes → ALARM: duplicate Plus charge. Refund required.
   *               Stamp the attempt with `alarmDuplicatePlus` + the
   *               existing sub id so admin /admin/payments can pick
   *               this up for manual intervention. Returns the
   *               EXISTING subscription unchanged.
   *         no  → INSERT a fresh ACTIVE Plus row (expires_at=NULL).
   *
   *   Pro (recurring):
   *     - existing per-(user, level, account=pro) row?
   *         yes → UPDATE: status=ACTIVE, refresh expires_at to NOW +
   *               cadence.durationDays. Used for both first-time
   *               activation and renewal cycles.
   *         no  → INSERT a fresh ACTIVE Pro row.
   *
   * Side effects (only on real subscription change):
   *   - back-fill payment_attempts.subscription_id
   *   - record promo redemption (best-effort; logs on failure)
   *   - invalidate entitlement cache
   *
   * Idempotent: a re-entry with the same paid attempt is a no-op for
   * the row that already references it.
   *
   * Returns `{ subscription, alarmDuplicatePlus }`. Callers must
   * SKIP the receipt email + financial-event ACTIVATION row when
   * `alarmDuplicatePlus` is true — the user owes a refund, not a
   * receipt.
   */
  private async consumePaidAttempt(
    attempt: PaymentAttempt,
    plan: SubscriptionPlanEntity,
    opts: {
      providerCustomerId?: string;
      providerSubscriptionId?: string;
      amountDisplay?: number;
      /**
       * Provider-supplied next-payment date. When present, used as the
       * recurring expiry — single source of truth for renewal cadence.
       * Without this the webhook can drift over cycles because two
       * concurrent handlers (charge.success / invoice.update) compute
       * the date with different clocks.
       */
      expiresAtOverride?: Date | null;
      /**
       * True when called from the webhook renewal-detection path. A
       * renewal MUST NOT resurrect a CANCELLED / REFUNDED subscription
       * — the caller should already have alarmed instead of reaching
       * us. We defensively re-check here.
       */
      isRenewal?: boolean;
    } = {},
  ): Promise<{ subscription: Subscription; alarmDuplicatePlus: boolean }> {
    const isOneTime = plan.paymentKind === PaymentKind.ONE_TIME;
    if (isOneTime && attempt.billingInterval) {
      throw new ConflictException(
        'One-time payments cannot carry a billing interval.',
      );
    }
    if (!isOneTime && !attempt.billingInterval) {
      throw new ConflictException(
        'Recurring payments require a billing interval.',
      );
    }

    // Look up the existing per-(user, level, account) subscription.
    // We exclude REFUNDED + EXPIRED rows — a refunded/expired sub on
    // the same (user, level, account) is the user lapsing and
    // re-buying, which is a legitimate fresh INSERT. CANCELLED rows
    // (lifetime Plus that was cancelled, or Pro in grace period) are
    // RETURNED here so the user-initiated re-buy path can re-activate
    // them; the renewal path applies its own additional guard below.
    const existing = await this.subsRepo
      .createQueryBuilder('s')
      .innerJoin(
        SubscriptionPlanEntity,
        'p',
        'p.id = s.plan_id AND p.level = :level AND p.account = :account',
        { level: plan.level, account: plan.account },
      )
      .where('s.user_id = :uid', { uid: attempt.userId })
      .andWhere(`s.status NOT IN ('refunded', 'expired')`)
      .orderBy('s.created_at', 'DESC')
      .getOne();

    // Renewal defense-in-depth: the webhook layer already alarms on a
    // CANCELLED/REFUNDED existingSub via onChargeSuccess, but if a
    // direct caller (admin tool, future code path) reaches here with
    // isRenewal=true and a CANCELLED row, refuse to resurrect.
    // Throwing trips the retry-with-error path in webhook processing
    // — the operator must intervene rather than have us silently
    // re-bill.
    if (opts.isRenewal && existing?.status === SubscriptionStatus.CANCELLED) {
      throw new ConflictException(
        'Renewal cannot resurrect a cancelled subscription.',
      );
    }

    const amountDisplay =
      opts.amountDisplay !== undefined
        ? opts.amountDisplay
        : Number(attempt.amountGhs);

    let saved: Subscription;
    let alarmDuplicatePlus = false;

    if (isOneTime) {
      if (existing) {
        // Duplicate Plus charge — the user already owns Plus on this
        // level for life. The system AUTO-REFUNDS via the provider
        // and flags the attempt for audit. Don't mutate the live
        // subscription, don't emit a receipt, don't record promo
        // redemption (caller + the skip below).
        alarmDuplicatePlus = true;
        this.logger.error(
          `[payments] duplicate Plus charge user=${attempt.userId} level=${plan.level} attempt=${attempt.id} existing=${existing.id} — auto-refund pending`,
        );

        // Best-effort auto-refund. If Paystack accepts the refund,
        // mark the attempt REFUNDED so the user's payment history
        // shows the correct state (and the admin "alarm" filter
        // only surfaces attempts that genuinely need manual
        // intervention). If the refund fails, leave the attempt
        // PAID with the alarm flag set — admin picks it up via
        // `/admin/payments?alarm=duplicate_plus` and refunds
        // manually in the Paystack dashboard.
        let refundOutcome: 'refunded' | 'pending' | 'failed' = 'failed';
        try {
          const provider = this.providers.get(attempt.provider);
          const refund = await provider.refundTransaction({
            reference: attempt.providerReference,
            amountMinor: attempt.amountMinor,
            currency: attempt.currency,
            reason: `duplicate_plus_charge: user already owns Plus on ${plan.level}`,
          });
          if (refund.status === 'processed' || refund.status === 'pending') {
            refundOutcome =
              refund.status === 'processed' ? 'refunded' : 'pending';
          }
        } catch (err) {
          this.logger.error(
            `[payments] auto-refund threw for duplicate Plus attempt=${attempt.id}: ${(err as Error).message}`,
          );
        }

        const meta: Record<string, unknown> = {
          ...(attempt.metadata ?? {}),
          alarmDuplicatePlus: true,
          duplicateOfSubscriptionId: existing.id,
          autoRefundOutcome: refundOutcome,
        };
        attempt.metadata = meta;
        attempt.subscriptionId = existing.id;
        await this.subsRepo.manager.getRepository(PaymentAttempt).save(attempt);

        // If the provider accepted the refund (status processed
        // immediately), flip the attempt to REFUNDED so the user's
        // history is correct. For 'pending' we leave it PAID — the
        // refund.processed webhook will flip it via applyRefund
        // when settlement completes.
        if (refundOutcome === 'refunded') {
          await this.paymentAttempts
            .markRefunded(attempt.id)
            .catch((err) =>
              this.logger.error(
                `[payments] failed to mark duplicate-Plus attempt=${attempt.id} REFUNDED after auto-refund: ${(err as Error).message}`,
              ),
            );
        }

        saved = existing;
      } else {
        saved = await this.subsRepo.save(
          this.subsRepo.create({
            userId: attempt.userId,
            planId: plan.id,
            billingInterval: null,
            provider: plan.provider,
            status: SubscriptionStatus.ACTIVE,
            providerReference: attempt.providerReference,
            providerCustomerId: opts.providerCustomerId ?? null,
            amountGhs: amountDisplay.toFixed(2),
            startsAt: new Date(),
            expiresAt: null,
            countryCode: plan.countryCode,
            promoCodeId: attempt.promoCodeId,
          }),
        );

        // Partner commission (Stream A). Fires only on the fresh-Plus
        // INSERT branch — never on duplicate-Plus alarm, never on Pro.
        // The commission service owns its own error handling: a
        // partner-side failure never rolls back the paid subscription.
        // The write is idempotent at the unique constraint
        // (partner_id, type, dedup_key=subscription_id) so a retry
        // (repair read, webhook replay) is absorbed as a no-op.
        this.partnerCommissions
          .creditPlusSubscription(saved.id)
          .catch((err) =>
            this.logger.error(
              `[consumePaidAttempt] partner Stream A threw sub=${saved.id}: ${(err as Error).message}`,
            ),
          );
      }
    } else {
      // Pro. Single source of truth for expires_at: prefer the
      // provider's nextPaymentDate when present (Paystack ships this
      // on invoice.update and on the data envelope of recurring
      // charge.success). Compute from cadence only when the provider
      // didn't supply one — first activation via /verify is the
      // typical case there.
      const cadence = this.plans.cadenceFor(
        plan,
        attempt.billingInterval as BillingInterval,
      );
      const newExpiry =
        opts.expiresAtOverride ??
        new Date(Date.now() + cadence.durationDays * 86400 * 1000);

      if (existing) {
        // Cadence switch (monthly → annual) — different
        // providerSubscriptionId. If the prior code exists and the
        // caller hands us a new one, instruct the provider to cancel
        // the old auto-debit BEFORE overwriting our row, otherwise
        // Paystack would keep debiting the old plan forever. The
        // mobile cancel-then-initiate flow already does this from the
        // client side; we skip the redundant call when our row is
        // already CANCELLED (mobile path) to avoid log noise and a
        // guaranteed Paystack 400 ("subscription already disabled").
        // Admin-initiated or future server-driven switches that go
        // through this code path without a prior cancel are still
        // protected by the provider call below.
        const cadenceSwitch =
          opts.providerSubscriptionId &&
          existing.providerSubscriptionId &&
          existing.providerSubscriptionId !== opts.providerSubscriptionId &&
          existing.provider;
        if (cadenceSwitch && existing.status !== SubscriptionStatus.CANCELLED) {
          try {
            const provider = this.providers.get(existing.provider as string);
            await provider.cancelSubscription({
              subscriptionId: existing.providerSubscriptionId as string,
              customerId: existing.providerCustomerId,
            });
          } catch (err) {
            this.logger.warn(
              `[consumePaidAttempt] failed to cancel prior providerSubscriptionId=${existing.providerSubscriptionId} on cadence switch: ${(err as Error).message}`,
            );
          }
        }
        existing.status = SubscriptionStatus.ACTIVE;
        existing.planId = plan.id;
        existing.billingInterval = attempt.billingInterval;
        existing.provider = plan.provider;
        existing.providerReference = attempt.providerReference;
        if (opts.providerSubscriptionId) {
          existing.providerSubscriptionId = opts.providerSubscriptionId;
        }
        if (opts.providerCustomerId) {
          existing.providerCustomerId = opts.providerCustomerId;
        }
        existing.amountGhs = amountDisplay.toFixed(2);
        existing.expiresAt = newExpiry;
        existing.startsAt = existing.startsAt ?? new Date();
        if (attempt.promoCodeId) existing.promoCodeId = attempt.promoCodeId;
        saved = await this.subsRepo.save(existing);
      } else {
        saved = await this.subsRepo.save(
          this.subsRepo.create({
            userId: attempt.userId,
            planId: plan.id,
            billingInterval: attempt.billingInterval,
            provider: plan.provider,
            status: SubscriptionStatus.ACTIVE,
            providerReference: attempt.providerReference,
            providerSubscriptionId: opts.providerSubscriptionId ?? null,
            providerCustomerId: opts.providerCustomerId ?? null,
            amountGhs: amountDisplay.toFixed(2),
            startsAt: new Date(),
            expiresAt: newExpiry,
            countryCode: plan.countryCode,
            promoCodeId: attempt.promoCodeId,
          }),
        );
      }
    }

    // Back-fill subscription_id on the attempt unless we already did
    // it above (duplicate-Plus path).
    if (attempt.subscriptionId !== saved.id) {
      await this.paymentAttempts.linkSubscription(attempt.id, saved.id);
    }

    // Promo redemption — best-effort. Bumping the counter + ledger
    // happens inside the service's own transaction with a unique
    // (code, user) index, so a duplicate apply is a graceful no-op.
    // SKIP on the duplicate-Plus alarm: the user is owed a refund and
    // the promo code's single-use slot must not be consumed for a
    // void charge.
    if (attempt.promoCodeId && !alarmDuplicatePlus) {
      await this.promoCodes
        .recordRedemption({
          codeId: attempt.promoCodeId,
          userId: attempt.userId,
          subscriptionId: saved.id,
          discountAmount: attempt.discountAmount
            ? Number(attempt.discountAmount)
            : 0,
          currency: attempt.currency,
        })
        .catch((err) => {
          this.logger.error(
            `[consumePaidAttempt] promo redemption write failed sub=${saved.id} code=${attempt.promoCodeId}: ${(err as Error).message}`,
          );
        });
    }

    await this.invalidateCache(attempt.userId);
    return { subscription: saved, alarmDuplicatePlus };
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
    // Pull ALL live subscriptions for the user (per-level scoped if
    // level was given), joined to the plan so we can read
    // `payment_kind` per row. We then pick the first RECURRING row
    // (Pro) as the cancellation target. Plus rows are intentionally
    // skipped — Plus is lifetime and has no recurring billing to
    // cancel; cancelling it would only strip the user's access
    // (entitlementFor treats CANCELLED + expires_at IS NULL as
    // Free). If the user holds Plus AND Pro on the same level, we
    // must cancel the Pro and leave Plus untouched — previously the
    // query picked "the most recent row" (Plus if bought after Pro)
    // and refused the entire cancel, which was a money-losing
    // regression.
    //
    // Order:
    //   1. RECURRING (Pro) rows, newest first → cancel target
    //   2. ONE_TIME (Plus) rows fall through to a separate "no
    //      recurring billing to cancel" message if no Pro was found
    // Raw column types come back as strings; cast to the enum via
    // a string comparison below rather than via TS narrowing so we
    // never silently miss a row whose payment_kind text doesn't
    // happen to match the enum casing exactly.
    type Row = {
      s_id: string;
      p_payment_kind: string;
    };
    const qb = this.subsRepo
      .createQueryBuilder('s')
      .innerJoin(
        SubscriptionPlanEntity,
        'p',
        level ? 'p.id = s.plan_id AND p.level = :level' : 'p.id = s.plan_id',
        level ? { level } : {},
      )
      .addSelect('p.payment_kind', 'p_payment_kind')
      .where('s.user_id = :uid', { uid: userId })
      .andWhere('s.status IN (:...statuses)', {
        statuses: [
          SubscriptionStatus.ACTIVE,
          SubscriptionStatus.TRIAL,
          SubscriptionStatus.XP_CREDITED,
        ],
      })
      .andWhere('(s.expires_at IS NULL OR s.expires_at > NOW())');
    const raw = await qb.orderBy('s.created_at', 'DESC').getRawAndEntities();
    const entities = raw.entities;
    const rawRows = raw.raw as Row[];

    if (entities.length === 0) {
      throw new NotFoundException('No active subscription');
    }

    // Locate the first Pro (RECURRING) row. Indices line up across
    // entities + raw since we used getRawAndEntities() on a single
    // query.
    let target: Subscription | null = null;
    for (let i = 0; i < entities.length; i++) {
      if (rawRows[i]?.p_payment_kind !== PaymentKind.ONE_TIME.toString()) {
        target = entities[i];
        break;
      }
    }

    if (!target) {
      // Only Plus rows exist on this level. Cancelling Plus is not
      // supported — surface a clear customer-facing message.
      throw new BadRequestException(
        'Plus is a lifetime plan and cannot be cancelled. Contact support if you need a refund.',
      );
    }
    const sub = target;

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
    await this.mail.send(
      MailEvent.SUBSCRIPTION_CANCELLED,
      user.email,
      {
        recipientName: user.fullName ?? undefined,
        planName: plan.name,
        level: plan.level.toUpperCase(),
        accessUntil: sub.expiresAt,
      },
      {
        userId: sub.userId,
        dedupKey: `subscription_cancelled:${sub.id}`,
      },
    );
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
     * Explicit expiry override. For recurring plans, when present this
     * is the SINGLE source of truth — used instead of computing
     * `now() + cadence.durationDays`. Pass the provider-reported
     * `nextPaymentDate` here so the webhook can't drift over cycles.
     * For one-time plans this is IGNORED (Plus is lifetime).
     */
    expiresAt?: Date;
    /**
     * True when the webhook handler synthesised the payment_attempt
     * for a Pro auto-renewal. Downstream guards refuse to resurrect a
     * CANCELLED/REFUNDED subscription when this is set — the renewal
     * branch in `onChargeSuccess` should already have alarmed before
     * reaching us, but defending here closes any future path that
     * arrives by other means.
     */
    isRenewal?: boolean;
  }): Promise<{ alarmDuplicatePlus: boolean }> {
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

    let alarmDuplicatePlus = false;
    await this.withUserAdvisoryLock(args.userId, async () => {
      // NEW MODEL: gate on the payment_attempt row. The webhook handler
      // is required to have written one before calling us — either at
      // initiate time for user-driven checkouts, or for Pro auto-renewals
      // by inserting a paid-attempt row on the fly (renewals don't go
      // through initiate but we still record them for history + audit).
      if (!args.providerReference) {
        // Defensive: provider didn't echo a reference. Refuse to insert a
        // blind subscription — without the reference we can't link the
        // payment_attempt for the history screen.
        this.logger.error(
          '[applyWebhookActivation] called without providerReference — refusing to grant entitlement',
        );
        return;
      }
      const attempt = await this.paymentAttempts.findByReference(
        args.providerReference,
      );
      if (!attempt) {
        // This branch is the "no_matching_payment" alarm path. The
        // webhook handler resolves it BEFORE getting here (so the
        // billing_log row records the alarm) — if we got here without
        // an attempt, the handler skipped the alarm path; log loudly.
        this.logger.error(
          `[applyWebhookActivation] no payment_attempt for reference=${args.providerReference} — alarm, no entitlement granted`,
        );
        return;
      }
      if (attempt.userId !== args.userId) {
        this.logger.error(
          `[applyWebhookActivation] attempt user mismatch ref=${args.providerReference} attempt.user=${attempt.userId} webhook.user=${args.userId}`,
        );
        return;
      }

      // Renewal race defense: when the webhook handler hands us
      // `isRenewal=true` with a `providerSubscriptionId`, the
      // sub-status check it did OUTSIDE this lock could have been
      // invalidated by a concurrent cancel() that finished between
      // then and now. Re-look-up the sub by providerSubscriptionId
      // INSIDE the lock and refuse PAID promotion if it's no longer
      // ACTIVE. The attempt is flipped to FAILED with a reason so
      // there's no orphan PAID row, no endless retries (the
      // attempt becomes terminal), and ops see the alarm via
      // billing_log + the FAILED attempt's failureReason.
      if (args.isRenewal && args.providerSubscriptionId) {
        const liveSub = await this.subsRepo.findOne({
          where: { providerSubscriptionId: args.providerSubscriptionId },
          select: ['id', 'status'],
        });
        if (!liveSub || liveSub.status !== SubscriptionStatus.ACTIVE) {
          this.logger.error(
            `[applyWebhookActivation] renewal race detected ref=${args.providerReference} ` +
              `sub=${liveSub?.id ?? 'missing'} status=${liveSub?.status ?? 'n/a'} — flipping attempt to FAILED, no entitlement granted`,
          );
          await this.paymentAttempts
            .markFailed(
              attempt.id,
              `renewal_race: target sub status=${liveSub?.status ?? 'missing'} at lock acquisition`,
            )
            .catch((err) =>
              this.logger.error(
                `[applyWebhookActivation] failed to mark renewal-race attempt as FAILED: ${(err as Error).message}`,
              ),
            );
          return;
        }
      }

      // Mark the attempt PAID (idempotent — replayed webhooks no-op).
      await this.paymentAttempts.markPaid(attempt.id, {
        providerCustomerId: args.providerCustomerId ?? null,
      });
      const refreshed = await this.paymentAttempts.findById(attempt.id);
      if (!refreshed) return;

      const result = await this.consumePaidAttempt(refreshed, args.plan, {
        providerCustomerId: args.providerCustomerId,
        providerSubscriptionId: args.providerSubscriptionId,
        amountDisplay: args.amountDisplay,
        expiresAtOverride: args.expiresAt ?? null,
        isRenewal: args.isRenewal,
      });
      alarmDuplicatePlus = result.alarmDuplicatePlus;
    });
    // consumePaidAttempt already invalidates on the happy path — keep
    // the explicit call here for the early-return branches above
    // (alarm / user mismatch) so the cache doesn't stay stale on
    // those edges.
    await this.invalidateCache(args.userId);
    return { alarmDuplicatePlus };
  }

  /**
   * Idempotent insert of a PENDING payment_attempt for a Pro
   * auto-renewal. Renewals don't go through initiate() (Paystack
   * auto-debits on the provider side and we only learn about the
   * charge via webhook). To keep the trust model intact AND give
   * renewals a row in the payment history screen, the webhook
   * handler calls this to plant the row just before
   * `applyWebhookActivation`.
   *
   * IMPORTANT: this method writes the attempt as PENDING. The
   * authoritative PAID transition happens INSIDE
   * `applyWebhookActivation`'s advisory lock, AFTER re-validating
   * that the linked subscription is still ACTIVE — closing the
   * cancel-vs-renewal race where Paystack debits a card the user
   * just cancelled. If the re-validation fails, `applyWebhookActivation`
   * flips the attempt to FAILED instead of PAID, so no orphan paid
   * row is left behind.
   *
   * Idempotency: unique `provider_reference` guards against double
   * inserts when Paystack retries the same delivery.
   */
  async recordPendingRenewalAttempt(input: {
    userId: string;
    planId: string;
    billingInterval: BillingInterval;
    amountMinor: number;
    amountGhs: number;
    currency: string;
    provider: string;
    providerReference: string;
    providerSubscriptionId?: string | null;
    providerCustomerId?: string | null;
    providerEventId?: string | null;
    subscriptionId?: string | null;
  }): Promise<PaymentAttempt> {
    const existing = await this.paymentAttempts.findByReference(
      input.providerReference,
    );
    if (existing) {
      // Already recorded — return the row as-is so a replay doesn't
      // duplicate. The status may already be PAID (a previous
      // retry of the same event id completed the full flow) or
      // FAILED (re-validation in the lock refused) — caller's
      // `applyWebhookActivation` handles both via its standard
      // attempt lookup + idempotent markPaid path.
      return existing;
    }
    return this.paymentAttempts.createPending({
      userId: input.userId,
      planId: input.planId,
      billingInterval: input.billingInterval,
      amountMinor: input.amountMinor,
      amountGhs: input.amountGhs,
      currency: input.currency,
      provider: input.provider,
      providerReference: input.providerReference,
      metadata: {
        source: 'renewal',
        providerSubscriptionId: input.providerSubscriptionId ?? null,
        providerEventId: input.providerEventId ?? null,
        targetSubscriptionId: input.subscriptionId ?? null,
      },
    });
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
    // We need to know the user id BEFORE acquiring the advisory lock
    // (the lock is keyed by user). Resolve it via the attempt row
    // first; if there's no attempt we still need to find the userId
    // off the subscription row in case the refund matched only a
    // subscription. Once known, the body runs under the lock so
    // refund + verify + charge.success can't interleave on the same
    // user. Without this, a refund flipping status to REFUNDED could
    // be silently undone by a concurrent verify upserting the row
    // back to ACTIVE.
    const attempt = await this.paymentAttempts.findByReference(reference);
    let lockUserId = attempt?.userId ?? null;
    if (!lockUserId) {
      const subForLookup = await this.subsRepo.findOne({
        where: { providerReference: reference },
        select: ['id', 'userId'],
      });
      lockUserId = subForLookup?.userId ?? null;
    }

    const apply = () => this.applyRefundLocked(reference);
    return lockUserId ? this.withUserAdvisoryLock(lockUserId, apply) : apply();
  }

  private async applyRefundLocked(
    reference: string,
  ): Promise<Subscription | null> {
    // Mark the payment_attempt as refunded first so the user's
    // payment history immediately reflects the refund — this is the
    // forensic anchor for "yes Paystack told us about this refund".
    // Order matters: if we flipped the subscription first and the
    // attempt update threw, the user would have lost access without
    // the corresponding history line.
    const attempt = await this.paymentAttempts.findByReference(reference);
    if (attempt && attempt.status !== PaymentAttemptStatus.REFUNDED) {
      try {
        await this.paymentAttempts.markRefunded(attempt.id);
      } catch (err) {
        this.logger.error(
          `[applyRefund] failed to mark payment_attempt ${attempt.id} as refunded: ${(err as Error).message}`,
        );
      }
    }

    const sub = await this.subsRepo.findOne({
      where: { providerReference: reference },
    });
    if (!sub) {
      // Refund landed on an attempt we never converted into a
      // subscription (e.g. duplicate-Plus alarm path where the
      // attempt was flagged but no live sub was created). Nothing
      // more to revoke; the attempt-side update above carries the
      // refund record.
      return null;
    }
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

    // Partner commission clawback. Non-blocking; the commission
    // service tolerates "no commission for this sub" (Pro refunds,
    // unattributed refunds) with a null return. Any failure logs and
    // moves on — the refund itself must not roll back if the partner
    // ledger write fails.
    this.partnerCommissions
      .clawback(sub.id, `refund.processed ref=${reference}`)
      .catch((err) =>
        this.logger.error(
          `[applyRefund] partner clawback threw sub=${sub.id}: ${(err as Error).message}`,
        ),
      );

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
