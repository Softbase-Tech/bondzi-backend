import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { Exam } from '../exams/entities/exam.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import { AiUsageLog } from '../ai/entities/ai-usage-log.entity';
import { QuestionFlag } from '../questions/entities/question-flag.entity';
import { Question } from '../questions/entities/question.entity';
import { AuditLog } from './entities/audit-log.entity';
import { redactPii } from '../../common/utils/redact-pii.util';
import {
  ExamStatus,
  ExamType,
  QuestionStatus,
  SubscriptionStatus,
} from '../../common/types/enums';
import { XpTransaction } from '../xp-economy/entities/xp-transaction.entity';
import { XpRedemption } from '../xp-economy/entities/xp-redemption.entity';
import { ReferralEvent } from '../referrals/entities/referral-event.entity';
import { PmTestQuestion } from '../pm-test/entities/pm-test-question.entity';
import { Winner } from '../leaderboard/entities/winner.entity';
import {
  PaginationDto,
  PaginatedResult,
} from '../../common/dto/pagination.dto';

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    @InjectRepository(Subscription)
    private readonly subsRepo: Repository<Subscription>,
    @InjectRepository(Exam) private readonly examsRepo: Repository<Exam>,
    @InjectRepository(ExamAnswer)
    private readonly answersRepo: Repository<ExamAnswer>,
    @InjectRepository(AiUsageLog)
    private readonly aiRepo: Repository<AiUsageLog>,
    @InjectRepository(QuestionFlag)
    private readonly flagsRepo: Repository<QuestionFlag>,
    @InjectRepository(Question)
    private readonly questionsRepo: Repository<Question>,
    @InjectRepository(AuditLog)
    private readonly auditRepo: Repository<AuditLog>,
    @InjectRepository(XpTransaction)
    private readonly xpTxRepo: Repository<XpTransaction>,
    @InjectRepository(XpRedemption)
    private readonly xpRedemptionRepo: Repository<XpRedemption>,
    @InjectRepository(ReferralEvent)
    private readonly referralsRepo: Repository<ReferralEvent>,
    @InjectRepository(PmTestQuestion)
    private readonly pmTestRepo: Repository<PmTestQuestion>,
    @InjectRepository(Winner) private readonly winnersRepo: Repository<Winner>,
  ) {}

  async dashboard() {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - 7);
    const start14d = new Date(now);
    start14d.setDate(now.getDate() - 14);

    const [
      users,
      activeSubs,
      answersToday,
      aiSpendToday,
      pendingFlags,
      mrrGhs,
      spendableXpSum,
      xpIssuedWeek,
      xpRedeemedWeek,
      referralSignupsWeek,
      referralQualifications,
      referralTotal,
      referralXpToday,
      referralDaily14d,
      activeUsersBece,
      activeUsersWassce,
      questionsBece,
      questionsWassce,
      questionsBeceExplained,
      questionsWassceExplained,
      pmTestActiveBece,
      pmTestActiveWassce,
      pmTestPendingReview,
      pmTestLastGen,
      winnersPendingBece,
      winnersPendingWassce,
    ] = await Promise.all([
      this.usersRepo.count({ where: { isActive: true } }),
      this.subsRepo.count({ where: { status: SubscriptionStatus.ACTIVE } }),
      this.answersRepo.count({
        where: { answeredAt: Between(startOfDay, now) },
      }),
      this.aiRepo
        .createQueryBuilder('a')
        .select('COALESCE(SUM(a.cost_usd),0)', 'total')
        .where('a.created_at >= :start', { start: startOfDay })
        .getRawOne<{ total: string }>(),
      this.flagsRepo.count({ where: { isResolved: false } }),
      this.subsRepo
        .createQueryBuilder('s')
        .select('COALESCE(SUM(s.amount_ghs),0)', 'total')
        .where('s.status = :st', { st: SubscriptionStatus.ACTIVE })
        .getRawOne<{ total: string }>(),
      this.usersRepo
        .createQueryBuilder('u')
        .select('COALESCE(SUM(u.spendable_xp),0)', 'total')
        .getRawOne<{ total: string }>(),
      this.xpTxRepo
        .createQueryBuilder('x')
        .select('COALESCE(SUM(x.level_xp),0)', 'total')
        .where('x.created_at >= :s', { s: weekStart })
        .getRawOne<{ total: string }>(),
      this.xpRedemptionRepo
        .createQueryBuilder('r')
        .select('COALESCE(SUM(r.xp_spent),0)', 'total')
        .where('r.applied_at >= :s', { s: weekStart })
        .getRawOne<{ total: string }>(),
      this.referralsRepo.count({
        where: { createdAt: Between(weekStart, now) },
      }),
      this.referralsRepo
        .createQueryBuilder('e')
        .select('COUNT(*)', 'total')
        .addSelect(
          'SUM(CASE WHEN e.qualify_xp_issued THEN 1 ELSE 0 END)',
          'qualified',
        )
        .getRawOne<{ total: string; qualified: string }>(),
      this.referralsRepo.count(),
      this.xpTxRepo
        .createQueryBuilder('x')
        .select('COALESCE(SUM(x.level_xp),0)', 'total')
        .where('x.created_at >= :s', { s: startOfDay })
        .andWhere("x.event_key LIKE 'referral_%'")
        .getRawOne<{ total: string }>(),
      this.referralsRepo
        .createQueryBuilder('e')
        .select("to_char(e.created_at, 'YYYY-MM-DD')", 'day')
        .addSelect('COUNT(*)::int', 'signups')
        .where('e.created_at >= :s', { s: start14d })
        .groupBy('day')
        .orderBy('day', 'ASC')
        .getRawMany<{ day: string; signups: number }>(),
      this.usersRepo.count({
        where: { isActive: true, examType: ExamType.BECE },
      }),
      this.usersRepo.count({
        where: { isActive: true, examType: ExamType.WASSCE },
      }),
      this.questionsRepo.count({
        where: { examType: ExamType.BECE, status: QuestionStatus.ACTIVE },
      }),
      this.questionsRepo.count({
        where: { examType: ExamType.WASSCE, status: QuestionStatus.ACTIVE },
      }),
      this.questionsRepo
        .createQueryBuilder('q')
        .where('q.exam_type = :e', { e: ExamType.BECE })
        .andWhere('q.status = :s', { s: QuestionStatus.ACTIVE })
        .andWhere('q.explanation IS NOT NULL')
        .getCount(),
      this.questionsRepo
        .createQueryBuilder('q')
        .where('q.exam_type = :e', { e: ExamType.WASSCE })
        .andWhere('q.status = :s', { s: QuestionStatus.ACTIVE })
        .andWhere('q.explanation IS NOT NULL')
        .getCount(),
      this.pmTestRepo.count({
        where: { examType: ExamType.BECE, status: QuestionStatus.ACTIVE },
      }),
      this.pmTestRepo.count({
        where: { examType: ExamType.WASSCE, status: QuestionStatus.ACTIVE },
      }),
      this.pmTestRepo.count({
        where: { status: QuestionStatus.PENDING_REVIEW },
      }),
      this.pmTestRepo
        .createQueryBuilder('q')
        .select('MAX(q.created_at)', 'last')
        .getRawOne<{ last: Date | null }>(),
      this.lastWeekNeedsWinners(ExamType.BECE, weekStart),
      this.lastWeekNeedsWinners(ExamType.WASSCE, weekStart),
    ]);

    const referralTotals = referralQualifications ?? {
      total: '0',
      qualified: '0',
    };
    const referralCount = parseInt(referralTotals.total, 10);
    const qualified = parseInt(referralTotals.qualified, 10);
    const qualificationRate = referralCount > 0 ? qualified / referralCount : 0;

    // Zero-fill the 14-day signup chart.
    const dailyMap = new Map(
      (referralDaily14d ?? []).map((r) => [r.day, Number(r.signups)]),
    );
    const daily14 = [] as Array<{ day: string; signups: number }>;
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      daily14.push({ day: iso, signups: dailyMap.get(iso) ?? 0 });
    }

    return {
      totalUsers: users,
      activeSubscriptions: activeSubs,
      mrrGhs: parseFloat(mrrGhs?.total ?? '0'),
      questionsAnsweredToday: answersToday,
      aiCostUsdToday: parseFloat(aiSpendToday?.total ?? '0'),
      pendingFlags,

      spendableXpOutstanding: parseInt(spendableXpSum?.total ?? '0', 10),
      xpIssuedThisWeek: parseInt(xpIssuedWeek?.total ?? '0', 10),
      xpRedeemedThisWeek: parseInt(xpRedeemedWeek?.total ?? '0', 10),

      referralSignupsThisWeek: referralSignupsWeek,
      referralQualificationRate: qualificationRate,
      referralXpIssuedToday: parseInt(referralXpToday?.total ?? '0', 10),
      referralDaily14d: daily14,
      totalReferrals: referralTotal,

      activeUsersBece,
      activeUsersWassce,
      questionsBece,
      questionsWassce,
      questionsBeceExplained,
      questionsWassceExplained,

      pmTestActiveBece,
      pmTestActiveWassce,
      pmTestPendingReview,
      pmTestLastGenerationAt: pmTestLastGen?.last
        ? pmTestLastGen.last.toISOString()
        : null,

      winnersPendingWeeklyBece: winnersPendingBece,
      winnersPendingWeeklyWassce: winnersPendingWassce,
      winnersPeriodEndedAt:
        winnersPendingBece || winnersPendingWassce
          ? weekStart.toISOString()
          : null,
    };
  }

  private async lastWeekNeedsWinners(
    examType: ExamType,
    periodStart: Date,
  ): Promise<boolean> {
    // If there are no confirmed winner rows for this exam_type + last week,
    // the admin needs to select. A cheap existence check on the Winner table.
    const iso = periodStart.toISOString().slice(0, 10);
    const count = await this.winnersRepo
      .createQueryBuilder('w')
      .where('w.exam_type = :e', { e: examType })
      .andWhere('w.period_type = :p', { p: 'weekly' })
      .andWhere('w.period_start = :d', { d: iso })
      .getCount();
    return count === 0;
  }

  async listAudit(
    p: PaginationDto,
  ): Promise<PaginatedResult<AuditLog & { adminName: string | null }>> {
    const page = p.page ?? 1;
    const limit = Math.min(200, Math.max(1, p.limit ?? 50));
    const [items, total] = await this.auditRepo.findAndCount({
      relations: ['admin'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const enriched = items.map((row) => ({
      ...row,
      adminName: row.admin?.fullName ?? null,
    }));
    return { items: enriched, total, nextCursor: null };
  }

  async listUsers(p: PaginationDto): Promise<PaginatedResult<User>> {
    const page = p.page ?? 1;
    const limit = p.limit ?? 20;
    const [items, total] = await this.usersRepo.findAndCount({
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total, nextCursor: null };
  }

  async listSubscriptions(
    p: PaginationDto,
  ): Promise<PaginatedResult<Subscription>> {
    const page = p.page ?? 1;
    const limit = Math.min(200, Math.max(1, p.limit ?? 50));
    const [items, total] = await this.subsRepo.findAndCount({
      relations: ['plan'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total, nextCursor: null };
  }

  async getUser(id: string) {
    const user = await this.usersRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    const [subscriptions, examsCount, aiUsage] = await Promise.all([
      this.subsRepo.find({
        where: { userId: id },
        relations: ['plan'],
        order: { createdAt: 'DESC' },
      }),
      this.examsRepo.count({
        where: { userId: id, status: ExamStatus.COMPLETED },
      }),
      this.aiRepo
        .createQueryBuilder('a')
        .select('COUNT(*)', 'calls')
        .addSelect('COALESCE(SUM(a.cost_usd),0)', 'cost')
        .where('a.user_id = :uid', { uid: id })
        .getRawOne<{ calls: string; cost: string }>(),
    ]);
    return { user, subscriptions, examsCount, aiUsage };
  }

  async banUser(adminId: string, userId: string, ip?: string): Promise<User> {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    const previous = { isActive: user.isActive };
    user.isActive = false;
    await this.usersRepo.save(user);
    await this.writeAuditLog(
      adminId,
      'user.ban',
      'user',
      userId,
      previous,
      { isActive: false },
      ip,
    );
    return user;
  }

  async listFlags(
    pagination: PaginationDto,
  ): Promise<PaginatedResult<QuestionFlag>> {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 20;
    const [items, total] = await this.flagsRepo.findAndCount({
      relations: ['question'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total, nextCursor: null };
  }

  async resolveFlag(
    adminId: string,
    flagId: string,
    ip?: string,
  ): Promise<QuestionFlag> {
    const flag = await this.flagsRepo.findOne({ where: { id: flagId } });
    if (!flag) throw new NotFoundException('Flag not found');
    flag.isResolved = true;
    flag.resolvedBy = adminId;
    flag.resolvedAt = new Date();
    await this.flagsRepo.save(flag);
    await this.writeAuditLog(
      adminId,
      'question_flag.resolve',
      'question_flag',
      flagId,
      null,
      { isResolved: true },
      ip,
    );
    return flag;
  }

  async aiUsageBreakdown() {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const start30Days = new Date(Date.now() - 30 * 86400 * 1000);

    const byDay = await this.aiRepo
      .createQueryBuilder('a')
      .select(`DATE_TRUNC('day', a.created_at)`, 'day')
      .addSelect('a.model', 'model')
      .addSelect('COUNT(*)', 'calls')
      .addSelect('COALESCE(SUM(a.cost_usd),0)', 'costUsd')
      .where('a.created_at >= :since', { since: start30Days })
      .groupBy('day')
      .addGroupBy('a.model')
      .orderBy('day', 'DESC')
      .getRawMany();

    const byAction = await this.aiRepo
      .createQueryBuilder('a')
      .select('a.action', 'action')
      .addSelect('COUNT(*)', 'calls')
      .addSelect('COALESCE(SUM(a.cost_usd),0)', 'costUsd')
      .where('a.created_at >= :since', { since: start30Days })
      .groupBy('a.action')
      .getRawMany();

    const topUsers = await this.aiRepo
      .createQueryBuilder('a')
      .select('a.user_id', 'userId')
      .addSelect('COUNT(*)', 'calls')
      .addSelect('COALESCE(SUM(a.cost_usd),0)', 'costUsd')
      .where('a.created_at >= :since', { since: start30Days })
      .andWhere('a.user_id IS NOT NULL')
      .groupBy('a.user_id')
      .orderBy('"costUsd"', 'DESC')
      .limit(20)
      .getRawMany();

    return { byDay, byAction, topUsers };
  }

  private async writeAuditLog(
    adminId: string,
    action: string,
    entityType: string,
    entityId: string | null,
    oldValue: Record<string, unknown> | null,
    newValue: Record<string, unknown> | null,
    ip?: string,
  ) {
    // Scrub PII from the delta before persisting. Audit rows are kept
    // for years; passing through raw email / phone / password_hash
    // would create a long-lived PII trove indistinguishable from the
    // users table itself. We keep entity ids and non-PII fields, so
    // forensics still tell the "who-did-what" story.
    const row = this.auditRepo.create({
      adminId,
      action,
      entityType,
      entityId,
      oldValue: oldValue
        ? (redactPii(oldValue) as Record<string, unknown>)
        : null,
      newValue: newValue
        ? (redactPii(newValue) as Record<string, unknown>)
        : null,
      ipAddress: ip ?? null,
    });
    await this.auditRepo.save(row);
  }
}
