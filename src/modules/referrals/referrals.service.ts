import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, DataSource, ILike, Repository } from 'typeorm';
import { ReferralEvent } from './entities/referral-event.entity';
import { User } from '../users/entities/user.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import { XpTransaction } from '../xp-economy/entities/xp-transaction.entity';
import { XpRateConfig } from '../xp-economy/entities/xp-rate-config.entity';
import { GamificationService } from '../gamification/gamification.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RedisService } from '../../common/redis/redis.service';
import { NotificationChannel } from '../../common/types/enums';
import { MailService } from '../mail/mail.service';
import { MailEvent } from '../mail/mail.types';

const QUALIFY_THRESHOLD = 10;

/**
 * First-name extractor. Referral list surfaces first names only —
 * full names are PII we don't need on the invite dashboard.
 */
function firstNameOf(fullName: string | undefined | null): string {
  if (!fullName) return 'Friend';
  const first = fullName.trim().split(/\s+/)[0];
  return first || 'Friend';
}

export interface ReferralStats {
  referralCode: string;
  referredCount: number;
  qualifiedCount: number;
  pendingCount: number;
  referralQualified: boolean;
  /**
   * Live XP rates from `xp_rate_config` — same source the awarder uses
   * — so the mobile "you earn N XP" copy always agrees with what the
   * ledger will actually credit. `questionsRequired` mirrors the
   * hard-coded `QUALIFY_THRESHOLD` above so the two never drift.
   */
  rates: {
    signup: number;
    qualify: number;
    questionsRequired: number;
  };
  /**
   * Total XP the caller has earned from referral events to date
   * (sum of xp_transactions.level_xp with event_key like `referral_%`).
   * Was fabricated to 0 client-side before; now sourced.
   */
  totalXpEarned: number;
  /** Admin-editable share message with `{code}` placeholder. */
  shareTemplate: string;
}

export interface ReferralEventRow {
  id: string;
  referredId: string;
  referralCode: string;
  /** First-name only. Full name is redacted. */
  firstName: string;
  signupXpIssued: boolean;
  qualifyXpIssued: boolean;
  qualifiedAt: string | null;
  createdAt: string;
  /** Number of exam answers the referred user has recorded to date. */
  answersToDate: number;
  /**
   * XP the referrer has actually earned from this specific referral
   * to date — sum of xp_transactions with `reference_id = event.id`
   * for `referral_referred` + `referral_qualified` event keys.
   */
  xpEarned: number;
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
    @InjectRepository(XpRateConfig)
    private readonly xpRatesRepo: Repository<XpRateConfig>,
    private readonly gamification: GamificationService,
    private readonly notifications: NotificationsService,
    private readonly redis: RedisService,
    private readonly dataSource: DataSource,
    private readonly mail: MailService,
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

    // Previously `count({ where: { exam: { userId } }, relations: { exam: true }})`
    // — TypeORM emits a join + subquery for that shape, and this method
    // fires on every answer submit + every exam complete, so the cost
    // multiplies with traffic. Drop to a single SQL count via the
    // existing index on (exam_id) and the cached (user_id) on exams.
    const countRows: { count: number }[] = await this.answersRepo.manager.query(
      `
        select count(*)::int as count
        from exam_answers a
        inner join exams e on e.id = a.exam_id
        where e.user_id = $1;
      `,
      [userId],
    );
    const count = countRows[0]?.count ?? 0;
    if (count < QUALIFY_THRESHOLD) return false;

    // CRITICAL: lock the referral_event row inside the tx so two
    // concurrent answer-complete handlers can't both pass the `count`
    // gate and both award `referral_qualified` XP to the referrer. The
    // SELECT FOR UPDATE on the qualifyXpIssued=false row forces them to
    // serialise; the second tx sees qualifyXpIssued=true and exits via
    // the early-return below.
    let alreadyQualified = false;
    try {
      await this.dataSource.transaction(async (em) => {
        const locked = await em
          .getRepository(ReferralEvent)
          .createQueryBuilder('e')
          .setLock('pessimistic_write')
          .where('e.id = :id', { id: event.id })
          .getOne();
        if (!locked || locked.qualifyXpIssued) {
          alreadyQualified = true;
          return;
        }
        await em.getRepository(ReferralEvent).update(event.id, {
          qualifyXpIssued: true,
          qualifiedAt: new Date(),
        });
        await em
          .getRepository(User)
          .update(userId, { referralQualified: true });
      });
      if (alreadyQualified) return false;
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

      // Email the referrer as well (best-effort) — same friendly tone,
      // PDF-free, just a celebratory note + nudge to keep sharing.
      const referrer = await this.usersRepo.findOne({
        where: { id: event.referrerId },
      });
      if (referrer?.email) {
        await this.mail.send(
          MailEvent.REFERRAL_QUALIFIED,
          referrer.email,
          {
            recipientName: referrer.fullName ?? undefined,
            refereeName: friendName,
            rewardXp: award.xpAmount,
          },
          {
            userId: event.referrerId,
            dedupKey: `referral_qualified:${event.referrerId}:${userId}`,
          },
        );
      }
      return true;
    } catch (err) {
      this.logger.warn(
        `referral qualification failed for user ${userId}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  async statsForUser(userId: string): Promise<ReferralStats> {
    const [user, referredCount, qualifiedCount, rates, xpRow, template] =
      await Promise.all([
        this.usersRepo.findOne({ where: { id: userId } }),
        this.eventsRepo.count({ where: { referrerId: userId } }),
        this.eventsRepo.count({
          where: { referrerId: userId, qualifyXpIssued: true },
        }),
        this.loadReferralRates(),
        this.xpTxRepo
          .createQueryBuilder('x')
          .select('COALESCE(SUM(x.level_xp), 0)', 'sum')
          .where('x.user_id = :userId', { userId })
          .andWhere("x.event_key LIKE 'referral_%'")
          .getRawOne<{ sum: string }>(),
        this.getShareTemplate(),
      ]);

    return {
      referralCode: user?.referralCode ?? '',
      referredCount,
      qualifiedCount,
      pendingCount: Math.max(0, referredCount - qualifiedCount),
      referralQualified: user?.referralQualified ?? false,
      rates,
      totalXpEarned: parseInt(xpRow?.sum ?? '0', 10),
      shareTemplate: template.template,
    };
  }

  /**
   * Reads the current XP amounts admin has configured for the two
   * referral event keys. Falls back to the migration defaults if a
   * row is missing (shouldn't happen post-migration but keeps the
   * response stable if ops accidentally drops one).
   */
  private async loadReferralRates(): Promise<ReferralStats['rates']> {
    const rows = await this.xpRatesRepo.find({
      where: [
        { eventKey: 'referral_referred' },
        { eventKey: 'referral_qualified' },
      ],
    });
    const byKey = new Map(rows.map((r) => [r.eventKey, r.xpAmount] as const));
    return {
      signup: byKey.get('referral_referred') ?? 50,
      qualify: byKey.get('referral_qualified') ?? 100,
      questionsRequired: QUALIFY_THRESHOLD,
    };
  }

  async listEvents(userId: string): Promise<ReferralEventRow[]> {
    const events = await this.eventsRepo.find({
      where: { referrerId: userId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
    if (events.length === 0) return [];

    const referredIds = events.map((e) => e.referredId);
    const eventIds = events.map((e) => e.id);

    // 3 cheap batched joins, all keyed by IDs we already have:
    //   1. Referred users' names (first-name only surfaces to mobile).
    //   2. Per-referred answer counts (drives the "N to go" pill).
    //   3. Per-event XP awarded so far (referral_referred + referral_qualified
    //      rows are stamped with reference_id = event.id).
    const [referredUsers, answerRows, xpRows] = await Promise.all([
      this.usersRepo.find({
        where: referredIds.map((id) => ({ id })),
        select: { id: true, fullName: true },
      }),
      this.answersRepo.manager.query<
        Array<{ user_id: string; count: number }>
      >(
        `
          select e.user_id::text as user_id, count(*)::int as count
          from exam_answers a
          inner join exams e on e.id = a.exam_id
          where e.user_id = any($1::uuid[])
          group by e.user_id
        `,
        [referredIds],
      ),
      this.xpTxRepo
        .createQueryBuilder('x')
        .select('x.reference_id', 'reference_id')
        .addSelect('COALESCE(SUM(x.level_xp), 0)', 'sum')
        .where('x.user_id = :userId', { userId })
        .andWhere("x.event_key LIKE 'referral_%'")
        .andWhere('x.reference_id = ANY(:ids)', { ids: eventIds })
        .groupBy('x.reference_id')
        .getRawMany<{ reference_id: string; sum: string }>(),
    ]);

    const nameById = new Map(
      referredUsers.map((u) => [u.id, u.fullName] as const),
    );
    const answersById = new Map(
      answerRows.map((r) => [r.user_id, r.count] as const),
    );
    const xpByEvent = new Map(
      xpRows.map((r) => [r.reference_id, parseInt(r.sum, 10)] as const),
    );

    return events.map((e) => ({
      id: e.id,
      referredId: e.referredId,
      referralCode: e.referralCode,
      firstName: firstNameOf(nameById.get(e.referredId)),
      signupXpIssued: e.signupXpIssued,
      qualifyXpIssued: e.qualifyXpIssued,
      qualifiedAt: e.qualifiedAt ? e.qualifiedAt.toISOString() : null,
      createdAt: e.createdAt.toISOString(),
      answersToDate: answersById.get(e.referredId) ?? 0,
      xpEarned: xpByEvent.get(e.id) ?? 0,
    }));
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
    'Join me on Bondzi Ghana and ace your exams. Use my code {code} when you sign up — we both earn XP. https://bondzi.online';

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
