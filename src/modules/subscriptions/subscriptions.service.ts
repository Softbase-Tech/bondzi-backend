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
import { BillingInterval, SubscriptionStatus } from '../../common/types/enums';
import { PaymentProviderRegistry } from '../payments/providers/payment-provider.registry';
import { User } from '../users/entities/user.entity';
import { Subscription } from './entities/subscription.entity';
import { PlansService } from './plans/plans.service';
import { SubscriptionPlanEntity } from './plans/entities/subscription-plan.entity';

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
  ) {}

  /**
   * v2: quick yes/no check used to gate the inline explanation field and to
   * tell the mobile client whether to show the lock badge. Reuses the same
   * Redis cache key as SubscriptionGuard so a webhook or XP redemption
   * invalidation flips both consumers at once.
   */
  async hasActiveSubscription(userId: string): Promise<boolean> {
    const sub = await this.getActiveSubscription(userId);
    return sub !== null;
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

  async getMine(userId: string): Promise<Subscription | null> {
    return this.subsRepo.findOne({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  async initiate(
    userId: string,
    planId: string,
    interval: BillingInterval,
  ): Promise<{ authorizationUrl: string; reference: string }> {
    const plan = await this.plans.getActiveForCheckout(planId);
    const cadence = this.plans.cadenceFor(plan, interval);
    if (!cadence.providerPlanCode) {
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

    const session = await provider.initializeCheckout({
      user: { id: user.id, email: user.email },
      providerPlanCode: cadence.providerPlanCode,
      amountMinor: cadence.amountMinor,
      currency: plan.currency,
      reference,
      metadata: {
        userId: user.id,
        planId: plan.id,
        interval,
        providerPlanCode: cadence.providerPlanCode,
      },
    });

    const pending = this.subsRepo.create({
      userId: user.id,
      planId: plan.id,
      billingInterval: interval,
      provider: plan.provider,
      status: SubscriptionStatus.TRIAL,
      providerReference: session.reference,
      amountGhs: cadence.amountDisplay.toFixed(2),
      startsAt: new Date(),
      expiresAt: new Date(Date.now() + cadence.durationDays * 86400 * 1000),
      countryCode: user.countryCode ?? plan.countryCode,
    });
    await this.subsRepo.save(pending);

    return {
      authorizationUrl: session.authorizationUrl,
      reference: session.reference,
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
  async verify(userId: string, reference: string): Promise<Subscription> {
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
    // Paystack on every page refresh.
    if (sub.status === SubscriptionStatus.ACTIVE) return sub;

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

    sub.status = SubscriptionStatus.ACTIVE;
    if (result.customerId) sub.providerCustomerId = result.customerId;
    await this.subsRepo.save(sub);

    await this.invalidateCache(userId);
    return sub;
  }

  async cancel(userId: string): Promise<Subscription> {
    // Widened from `status: ACTIVE` only. The previous shape returned
    // 404 for users on a TRIAL or XP_CREDITED row even though they had
    // active access — and the UI cancel button was visible to them.
    // Now we cancel whatever live grant they hold.
    const sub = await this.subsRepo
      .createQueryBuilder('s')
      .where('s.user_id = :uid', { uid: userId })
      .andWhere('s.status IN (:...statuses)', {
        statuses: [
          SubscriptionStatus.ACTIVE,
          SubscriptionStatus.TRIAL,
          SubscriptionStatus.XP_CREDITED,
        ],
      })
      .andWhere('(s.expires_at IS NULL OR s.expires_at > NOW())')
      .orderBy('s.created_at', 'DESC')
      .getOne();
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
    return sub;
  }

  async invalidateCache(userId: string): Promise<void> {
    await this.redis.del(CacheKeys.subscriptionStatus(userId));
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
    interval: BillingInterval;
    providerReference?: string;
    providerSubscriptionId?: string;
    providerCustomerId?: string;
    amountDisplay?: number;
    expiresAt?: Date;
  }): Promise<void> {
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

      const cadence = this.plans.cadenceFor(args.plan, args.interval);
      const defaultExpiry = new Date(
        Date.now() + cadence.durationDays * 86400 * 1000,
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
        existing.expiresAt = args.expiresAt ?? defaultExpiry;
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
          expiresAt: args.expiresAt ?? defaultExpiry,
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
