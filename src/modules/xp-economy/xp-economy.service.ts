import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { XpRateConfig } from './entities/xp-rate-config.entity';
import { XpRedemptionConfig } from './entities/xp-redemption-config.entity';
import { XpTransaction } from './entities/xp-transaction.entity';
import { XpRedemption } from './entities/xp-redemption.entity';
import { User } from '../users/entities/user.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { SubscriptionStatus } from '../../common/types/enums';
import { RedisService } from '../../common/redis/redis.service';
import { CacheKeys } from '../../common/utils/cache-keys.util';
import { GamificationService } from '../gamification/gamification.service';

export interface RedeemResult {
  success: true;
  tierKey: string;
  xpSpent: number;
  creditDays: number;
  newSpendableXp: number;
  subscriptionExpiresAt: string;
}

/**
 * v2 XP redemption + introspection. awardXp lives on GamificationService;
 * this service handles the spending side + read endpoints (/xp, /xp/tiers,
 * /xp/history, POST /xp/redeem).
 */
@Injectable()
export class XpEconomyService {
  private readonly logger = new Logger(XpEconomyService.name);

  constructor(
    @InjectRepository(XpRateConfig)
    private readonly ratesRepo: Repository<XpRateConfig>,
    @InjectRepository(XpRedemptionConfig)
    private readonly tiersRepo: Repository<XpRedemptionConfig>,
    @InjectRepository(XpTransaction)
    private readonly txRepo: Repository<XpTransaction>,
    @InjectRepository(XpRedemption)
    private readonly redemptionsRepo: Repository<XpRedemption>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    @InjectRepository(Subscription)
    private readonly subsRepo: Repository<Subscription>,
    private readonly gamification: GamificationService,
    private readonly redis: RedisService,
    private readonly dataSource: DataSource,
  ) {}

  /** Active earning rates — shown on the XP screen so students see how they earn. */
  listRates() {
    return this.ratesRepo.find({
      where: { isActive: true },
      order: { xpAmount: 'DESC' },
    });
  }

  /** Active redemption tiers — price cards on /xp/redeem. */
  listTiers() {
    return this.tiersRepo.find({
      where: { isActive: true },
      order: { xpCost: 'ASC' },
    });
  }

  /**
   * User's current XP snapshot (level/total/spendable/streak) plus rates and
   * tiers. Single round-trip powers the whole XP screen.
   */
  async summary(userId: string) {
    const [snapshot, tiers, rates] = await Promise.all([
      this.gamification.snapshot(userId),
      this.listTiers(),
      this.listRates(),
    ]);
    return { ...snapshot, tiers, rates };
  }

  history(userId: string, limit = 50) {
    return this.txRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: Math.min(200, Math.max(1, limit)),
    });
  }

  /**
   * Redeem spendable XP for N subscription days. Single transaction:
   *   1. Reserve XP (spendable -= tier.xp_cost). If the subtract underflows
   *      on the DB side, we throw BadRequest.
   *   2. Insert xp_redemption row.
   *   3. Insert subscription(plan=xp_credit, status=xp_credited, expires=now+days).
   *      If an existing active subscription overlaps, we *extend* its expiry.
   *   4. Insert xp_transaction(-xp_cost on spendable only).
   * Invalidates the subscription cache so SubscriptionGuard / explanation gate
   * pick the new state up immediately.
   */
  async redeem(userId: string, tierKey: string): Promise<RedeemResult> {
    const tier = await this.tiersRepo.findOne({
      where: { tierKey, isActive: true },
    });
    if (!tier) {
      throw new NotFoundException(`Unknown or disabled tier '${tierKey}'`);
    }

    const result = await this.dataSource.transaction(async (em) => {
      const usersRepo = em.getRepository(User);
      const redemptionsRepo = em.getRepository(XpRedemption);
      const subsRepo = em.getRepository(Subscription);
      const txRepo = em.getRepository(XpTransaction);

      const updateRes = await usersRepo
        .createQueryBuilder()
        .update(User)
        .set({ spendableXp: () => `"spendable_xp" - ${tier.xpCost}` })
        .where('id = :id AND spendable_xp >= :cost', {
          id: userId,
          cost: tier.xpCost,
        })
        .execute();
      if ((updateRes.affected ?? 0) === 0) {
        throw new BadRequestException('Insufficient spendable XP');
      }

      const redemption = redemptionsRepo.create({
        userId,
        tierKey,
        xpSpent: tier.xpCost,
        creditDays: tier.creditDays,
      });
      await redemptionsRepo.save(redemption);

      const creditMs = tier.creditDays * 24 * 60 * 60 * 1000;
      const now = new Date();

      // CRITICAL: do NOT create a stacked row when an active subscription
      // already exists. The previous shape silently inserted an
      // XP_CREDITED row on top of a paid ACTIVE one, which let a user
      // pay via Paystack, redeem XP, then chargeback and still hold
      // premium via the XP_CREDITED row. We now EXTEND whichever active
      // sub the user already has by `creditDays`, so a chargeback that
      // flips the paid row to REFUNDED also removes the extension.
      //
      // Selection: take the latest active row (paid ACTIVE, TRIAL, or
      // existing XP_CREDITED). Fall back to creating a fresh
      // XP_CREDITED row only when no active sub exists at all.
      const existingActive = await subsRepo
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
        .orderBy('s.expires_at', 'DESC')
        .getOne();

      let subscription: Subscription;
      if (existingActive) {
        // Anchor the extension on the LATER of (now, current expires_at)
        // so a sub already expiring next year gets +N days from that
        // future date, not from today. Status stays as-is — a paid
        // ACTIVE row stays ACTIVE; an XP_CREDITED row picks up the new
        // redemption pointer for audit lineage.
        const base = existingActive.expiresAt
          ? Math.max(existingActive.expiresAt.getTime(), now.getTime())
          : now.getTime();
        existingActive.expiresAt = new Date(base + creditMs);
        if (existingActive.status === SubscriptionStatus.XP_CREDITED) {
          existingActive.xpRedemptionId = redemption.id;
        }
        subscription = await subsRepo.save(existingActive);
      } else {
        const fresh = subsRepo.create({
          userId,
          planId: null,
          billingInterval: null,
          provider: null,
          status: SubscriptionStatus.XP_CREDITED,
          startsAt: now,
          expiresAt: new Date(now.getTime() + creditMs),
          xpRedemptionId: redemption.id,
        });
        subscription = await subsRepo.save(fresh);
      }

      await txRepo.insert({
        userId,
        eventKey: 'redemption',
        levelXp: 0,
        spendableXp: -tier.xpCost,
        referenceId: redemption.id,
      });

      const user = await usersRepo.findOne({ where: { id: userId } });
      return {
        user,
        subscription,
      };
    });

    await this.redis
      .del(CacheKeys.subscriptionStatus(userId))
      .catch(() => void 0);

    const user = result.user;
    const sub = result.subscription;
    return {
      success: true,
      tierKey,
      xpSpent: tier.xpCost,
      creditDays: tier.creditDays,
      newSpendableXp: Number(user?.spendableXp ?? 0),
      subscriptionExpiresAt:
        sub.expiresAt?.toISOString() ?? new Date().toISOString(),
    };
  }
}
