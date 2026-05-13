import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { CacheKeys } from '../../common/utils/cache-keys.util';
import { RedisService } from '../../common/redis/redis.service';
import { BillingInterval, SubscriptionStatus } from '../../common/types/enums';
import { PaymentProviderRegistry } from '../payments/providers/payment-provider.registry';
import { User } from '../users/entities/user.entity';
import { Subscription } from './entities/subscription.entity';
import { PlansService } from './plans/plans.service';
import { SubscriptionPlanEntity } from './plans/entities/subscription-plan.entity';

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
   * "success" — always reconfirm with the provider.
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

    const provider = this.providers.get(sub.provider);
    const result = await provider.verifyTransaction(reference);
    if (result.status !== 'success') {
      throw new ConflictException(
        `Provider verification returned status=${result.status}`,
      );
    }

    sub.status = SubscriptionStatus.ACTIVE;
    if (result.customerId) sub.providerCustomerId = result.customerId;
    await this.subsRepo.save(sub);

    await this.invalidateCache(userId);
    return sub;
  }

  async cancel(userId: string): Promise<Subscription> {
    const sub = await this.subsRepo.findOne({
      where: { userId, status: SubscriptionStatus.ACTIVE },
      order: { createdAt: 'DESC' },
    });
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
    const existing = await this.subsRepo.findOne({
      where: args.providerReference
        ? { providerReference: args.providerReference }
        : { userId: args.userId },
      order: { createdAt: 'DESC' },
    });

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
    await this.invalidateCache(args.userId);
  }

  async applyWebhookStatus(
    userId: string,
    status: SubscriptionStatus,
  ): Promise<void> {
    await this.subsRepo.update({ userId }, { status });
    await this.invalidateCache(userId);
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
