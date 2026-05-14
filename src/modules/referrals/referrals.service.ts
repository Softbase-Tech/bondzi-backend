import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, DataSource, ILike, Repository } from 'typeorm';
import { ReferralEvent } from './entities/referral-event.entity';
import { User } from '../users/entities/user.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import { XpTransaction } from '../xp-economy/entities/xp-transaction.entity';
import { GamificationService } from '../gamification/gamification.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RedisService } from '../../common/redis/redis.service';
import { NotificationChannel } from '../../common/types/enums';

const QUALIFY_THRESHOLD = 10;

export interface ReferralStats {
  referralCode: string;
  referredCount: number;
  qualifiedCount: number;
  pendingCount: number;
  referralQualified: boolean;
}

/**
 * v2 referral system — three responsibilities:
 *  1. Issue signup XP (both sides) when a new user registers with a code.
 *  2. Watch referred users' answer counts; when they cross 10 answered, flip
 *     referral_qualified and issue the qualification XP to the referrer.
 *  3. Expose stats for the referral screen.
 *
 * `AuthService` handles the referral_event row insertion at registration; this
 * service handles the XP issuance (post-commit) and qualification promotion.
 */
@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);

  constructor(
    @InjectRepository(ReferralEvent)
    private readonly eventsRepo: Repository<ReferralEvent>,
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    @InjectRepository(ExamAnswer)
    private readonly answersRepo: Repository<ExamAnswer>,
    @InjectRepository(XpTransaction)
    private readonly xpTxRepo: Repository<XpTransaction>,
    private readonly gamification: GamificationService,
    private readonly notifications: NotificationsService,
    private readonly redis: RedisService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Issue the two signup rewards (referral_referred to referrer,
   * referral_new_user to the new user) and flip signup_xp_issued=true.
   * No-op if the row is missing or already issued.
   */
  async issueSignupRewards(referredUserId: string): Promise<void> {
    const event = await this.eventsRepo.findOne({
      where: { referredId: referredUserId, signupXpIssued: false },
    });
    if (!event) return;

    try {
      await this.gamification.awardXp(
        event.referrerId,
        'referral_referred',
        event.id,
      );
      await this.gamification.awardXp(
        event.referredId,
        'referral_new_user',
        event.id,
      );
      await this.eventsRepo.update(event.id, { signupXpIssued: true });
    } catch (err) {
      this.logger.warn(
        `referral signup XP issue failed for event ${event.id}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Triggered after each exam completion (and safe on every answer). When the
   * referred user has answered at least 10 questions ever, qualify them:
   *   - flip users.referral_qualified
   *   - flip referral_events.qualify_xp_issued
   *   - award referral_qualified XP to the referrer
   */
  async checkQualification(userId: string): Promise<boolean> {
    const event = await this.eventsRepo.findOne({
      where: { referredId: userId, qualifyXpIssued: false },
    });
    if (!event) return false;

    const count = await this.answersRepo.count({
      where: { exam: { userId } },
      relations: { exam: true },
    });
    if (count < QUALIFY_THRESHOLD) return false;

    try {
      await this.dataSource.transaction(async (em) => {
        await em.getRepository(ReferralEvent).update(event.id, {
          qualifyXpIssued: true,
          qualifiedAt: new Date(),
        });
        await em
          .getRepository(User)
          .update(userId, { referralQualified: true });
      });
      const award = await this.gamification.awardXp(
        event.referrerId,
        'referral_qualified',
        event.id,
      );
      // Spec §6.2 step d: notify the referrer.
      const referred = await this.usersRepo.findOne({ where: { id: userId } });
      const friendName = referred?.fullName.split(' ')[0] ?? 'Your friend';
      await this.notifications
        .send({
          userId: event.referrerId,
          channel: NotificationChannel.PUSH,
          title: 'Referral qualified! 🎉',
          body: `${friendName} just qualified! You earned ${award.xpAmount} XP.`,
          data: {
            type: 'referral_qualified',
            referredId: userId,
            xpEarned: award.xpAmount,
          },
        })
        .catch(() => void 0);
      return true;
    } catch (err) {
      this.logger.warn(
        `referral qualification failed for user ${userId}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  async statsForUser(userId: string): Promise<ReferralStats> {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    const referredCount = await this.eventsRepo.count({
      where: { referrerId: userId },
    });
    const qualifiedCount = await this.eventsRepo.count({
      where: { referrerId: userId, qualifyXpIssued: true },
    });
    return {
      referralCode: user?.referralCode ?? '',
      referredCount,
      qualifiedCount,
      pendingCount: Math.max(0, referredCount - qualifiedCount),
      referralQualified: user?.referralQualified ?? false,
    };
  }

  async listEvents(userId: string): Promise<ReferralEvent[]> {
    return this.eventsRepo.find({
      where: { referrerId: userId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  // ---------------------------------------------------------------------------
  // v2 — /admin/referrals/*
  // Admin dashboard queries. Build cheap rollups from referral_events +
  // xp_transactions (referral_* event_keys). Called by the admin UI on
  // /admin/referrals.
  // ---------------------------------------------------------------------------

  async adminMetrics(): Promise<{
    totalSignups: number;
    qualificationRate: number;
    totalXpIssued: number;
    signupsThisWeek: number;
    daily30d: Array<{ day: string; signups: number; qualified: number }>;
  }> {
    const totalSignups = await this.eventsRepo.count();
    const qualified = await this.eventsRepo.count({
      where: { qualifyXpIssued: true },
    });
    const qualificationRate = totalSignups > 0 ? qualified / totalSignups : 0;

    const xpSum = await this.xpTxRepo
      .createQueryBuilder('x')
      .select('COALESCE(SUM(x.level_xp), 0)', 'sum')
      .where("x.event_key LIKE 'referral_%'")
      .getRawOne<{ sum: string }>();
    const totalXpIssued = parseInt(xpSum?.sum ?? '0', 10);

    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - 7);
    const signupsThisWeek = await this.eventsRepo.count({
      where: { createdAt: Between(weekStart, now) },
    });

    const daily30d = await this.adminDaily30d();

    return {
      totalSignups,
      qualificationRate,
      totalXpIssued,
      signupsThisWeek,
      daily30d,
    };
  }

  private async adminDaily30d(): Promise<
    Array<{ day: string; signups: number; qualified: number }>
  > {
    const rows = await this.eventsRepo
      .createQueryBuilder('e')
      .select("to_char(e.created_at, 'YYYY-MM-DD')", 'day')
      .addSelect('COUNT(*)', 'signups')
      .addSelect(
        'SUM(CASE WHEN e.qualify_xp_issued = true THEN 1 ELSE 0 END)',
        'qualified',
      )
      .where("e.created_at >= now() - interval '30 days'")
      .groupBy('day')
      .orderBy('day', 'ASC')
      .getRawMany<{ day: string; signups: string; qualified: string }>();

    // Fill missing days with zero so the chart is contiguous.
    const out: Array<{ day: string; signups: number; qualified: number }> = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      const match = rows.find((r) => r.day === iso);
      out.push({
        day: iso,
        signups: match ? parseInt(match.signups, 10) : 0,
        qualified: match ? parseInt(match.qualified, 10) : 0,
      });
    }
    return out;
  }

  async adminTopReferrers(limit = 50): Promise<
    Array<{
      userId: string;
      fullName: string;
      examType: string;
      totalReferrals: number;
      qualifiedReferrals: number;
      totalXpEarned: number;
      lastReferralAt: string | null;
    }>
  > {
    // Group referral_events by referrer; left-join users for name/exam_type;
    // left-join a sum of referral_* XP per referrer.
    const rows = await this.eventsRepo
      .createQueryBuilder('e')
      .leftJoin('users', 'u', 'u.id = e.referrer_id')
      .leftJoin(
        (qb) =>
          qb
            .from('xp_transactions', 'x')
            .select('x.user_id', 'user_id')
            .addSelect('SUM(x.level_xp)', 'sum')
            .where("x.event_key LIKE 'referral_%'")
            .groupBy('x.user_id'),
        'xp',
        '"xp"."user_id" = e.referrer_id',
      )
      .select('e.referrer_id', 'userId')
      .addSelect('u.full_name', 'fullName')
      .addSelect('u.exam_type', 'examType')
      .addSelect('COUNT(*)::int', 'totalReferrals')
      .addSelect(
        'SUM(CASE WHEN e.qualify_xp_issued = true THEN 1 ELSE 0 END)::int',
        'qualifiedReferrals',
      )
      .addSelect('COALESCE(MAX("xp"."sum"), 0)::int', 'totalXpEarned')
      .addSelect('MAX(e.created_at)', 'lastReferralAt')
      .groupBy('e.referrer_id')
      .addGroupBy('u.full_name')
      .addGroupBy('u.exam_type')
      .orderBy('"totalReferrals"', 'DESC')
      .limit(limit)
      .getRawMany<{
        userId: string;
        fullName: string | null;
        examType: string | null;
        totalReferrals: number;
        qualifiedReferrals: number;
        totalXpEarned: number;
        lastReferralAt: Date | null;
      }>();

    return rows.map((r) => ({
      userId: r.userId,
      fullName: r.fullName ?? 'Unknown',
      examType: r.examType ?? 'wassce',
      totalReferrals: Number(r.totalReferrals),
      qualifiedReferrals: Number(r.qualifiedReferrals),
      totalXpEarned: Number(r.totalXpEarned),
      lastReferralAt: r.lastReferralAt ? r.lastReferralAt.toISOString() : null,
    }));
  }

  async adminChain(query: string): Promise<
    Array<{
      referredId: string;
      referredName: string;
      qualified: boolean;
      qualifiedAt: string | null;
      signupXpIssued: boolean;
      qualifyXpIssued: boolean;
      createdAt: string;
    }>
  > {
    const q = query.trim();
    if (!q) return [];

    const referrer = await this.usersRepo.findOne({
      where: [{ referralCode: q.toUpperCase() }, { fullName: ILike(`%${q}%`) }],
    });
    if (!referrer) return [];

    const events = await this.eventsRepo.find({
      where: { referrerId: referrer.id },
      order: { createdAt: 'DESC' },
      take: 50,
    });

    if (events.length === 0) return [];

    const ids = events.map((e) => e.referredId);
    const referredUsers = await this.usersRepo.find({
      where: ids.map((id) => ({ id })),
      select: ['id', 'fullName'],
    });
    const nameById = new Map(referredUsers.map((u) => [u.id, u.fullName]));

    return events.map((e) => ({
      referredId: e.referredId,
      referredName: nameById.get(e.referredId) ?? 'Unknown',
      qualified: Boolean(e.qualifiedAt),
      qualifiedAt: e.qualifiedAt ? e.qualifiedAt.toISOString() : null,
      signupXpIssued: e.signupXpIssued,
      qualifyXpIssued: e.qualifyXpIssued,
      createdAt: e.createdAt.toISOString(),
    }));
  }

  // Share template — editable by admin, cached in Redis. Falls back to a
  // platform default if the admin hasn't customised it.
  private readonly SHARE_TEMPLATE_KEY = 'referral:share-template';
  private readonly DEFAULT_SHARE_TEMPLATE =
    'Join me on PassMaster Ghana and ace your exams. Use my code {code} when you sign up — we both earn XP. https://passmaster.gh';

  async getShareTemplate(): Promise<{ template: string }> {
    const cached = await this.redis.getString(this.SHARE_TEMPLATE_KEY);
    return { template: cached ?? this.DEFAULT_SHARE_TEMPLATE };
  }

  async setShareTemplate(template: string): Promise<{ template: string }> {
    // No TTL — this is admin config, persists until overwritten.
    await this.redis.setString(this.SHARE_TEMPLATE_KEY, template);
    return { template };
  }
}
