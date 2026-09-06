import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
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
  UserRole,
} from '../../common/types/enums';
import { XpTransaction } from '../xp-economy/entities/xp-transaction.entity';
import { XpRedemption } from '../xp-economy/entities/xp-redemption.entity';
import { ReferralEvent } from '../referrals/entities/referral-event.entity';
import { PmTestQuestion } from '../pm-test/entities/pm-test-question.entity';
import { Winner } from '../leaderboard/entities/winner.entity';
import { AuthLoginEvent } from '../auth/entities/auth-login-event.entity';
import {
  PaginationDto,
  PaginatedResult,
} from '../../common/dto/pagination.dto';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

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
    @InjectRepository(AuthLoginEvent)
    private readonly loginEventsRepo: Repository<AuthLoginEvent>,
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
      activeUsersNovdec,
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
      winnersPendingNovdec,
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
      this.usersRepo.count({
        where: { isActive: true, examType: ExamType.NOVDEC },
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
      this.lastWeekNeedsWinners(ExamType.NOVDEC, weekStart),
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
      // NOVDEC users are a distinct level for billing / leaderboards even
      // though they share the WASSCE question pool. We don't surface a
      // separate `questionsNovdec` tile because the catalogue numbers
      // would just duplicate `questionsWassce`.
      activeUsersNovdec,
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
      winnersPendingWeeklyNovdec: winnersPendingNovdec,
      winnersPeriodEndedAt:
        winnersPendingBece || winnersPendingWassce || winnersPendingNovdec
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

  async listUsers(
    p: PaginationDto & { search?: string },
  ): Promise<PaginatedResult<User>> {
    const page = p.page ?? 1;
    const limit = p.limit ?? 20;
    // Optional search: matches against full_name / email / phone /
    // username with case-insensitive LIKE. Powers the admin "send push
    // to a specific user" picker — the operator types a name, the UI
    // shows the top N matches. Empty / undefined search falls through
    // to the unfiltered list so existing callers (the users index page)
    // don't change behaviour.
    const search = p.search?.trim();
    const qb = this.usersRepo
      .createQueryBuilder('u')
      .orderBy('u.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);
    if (search) {
      const needle = `%${search.toLowerCase()}%`;
      qb.andWhere(
        '(lower(u.full_name) like :q OR lower(u.email) like :q OR lower(u.username) like :q OR u.phone like :q)',
        { q: needle },
      );
    }
    const [items, total] = await qb.getManyAndCount();
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
    const [subscriptions, examsCount, aiUsage, loginEvents] = await Promise.all(
      [
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
        // Last 20 sign-ins across all platforms. `auth_login_events` is
        // append-only + only records real sign-ins (register / login /
        // google / otp), so this is a durable history — refresh-token
        // rotations don't pollute it. Enough rows for a support agent to
        // spot pattern shifts ("suddenly all logins are Android") without
        // paging.
        this.loginEventsRepo.find({
          where: { userId: id },
          order: { createdAt: 'DESC' },
          take: 20,
        }),
      ],
    );
    return { user, subscriptions, examsCount, aiUsage, loginEvents };
  }

  /**
   * Auth analytics — signups and login events sliced by platform.
   *
   * **Students only.** Every aggregate below is filtered to
   * `role = 'student'`. This is a product-growth surface: it answers
   * "how are students reaching us, and on what?" Operator traffic
   * (admin / superadmin / teacher) is not acquisition — a handful of
   * staff signing into the console several times a day would otherwise
   * sit in the same bars as real signups and inflate the 'web' and
   * 'admin-web' buckets against a much larger student denominator.
   *
   * Operator activity is not lost, just kept out of the growth numbers:
   * it is still visible per-account in `userDetail().loginEvents`, which
   * is deliberately unfiltered because that view is a support tool.
   *
   * Second-order effect, and a desirable one: the login aggregates reach
   * `role` by joining `users`, and `User` is soft-deletable, so TypeORM
   * appends `u.deleted_at IS NULL` to that join. Sign-ins belonging to
   * deleted accounts therefore drop out too. That is the consistent
   * answer — the signup aggregates read `users` directly and have always
   * excluded them, so before this the two halves of the page disagreed
   * about whether a deleted account counted.
   *
   *   • `signups.byPlatform` — all-time distribution across student
   *     accounts. Answers "which surface has produced the most
   *     accounts to date?"
   *   • `signups.last30d` — daily counts per platform for the last 30
   *     days, so growth-side stakeholders can see cadence, not just
   *     the total.
   *   • `logins.byPlatform` — the last 30 days of `auth_login_events`
   *     grouped by platform × event type. Distinguishes register
   *     bursts from password login vs Google vs OTP.
   *
   * All counts include a `null` bucket for rows that arrived without
   * an X-Platform header (legacy clients, non-instrumented scripts).
   */
  async authAnalytics() {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);

    type Row = { platform: string | null; count: string };
    type EventRow = {
      platform: string | null;
      event_type: string;
      count: string;
    };
    type DailyRow = { day: string; platform: string | null; count: string };

    const [signupsAll, signupsLast30, loginsByPlatform, loginsDaily] =
      await Promise.all([
        this.usersRepo
          .createQueryBuilder('u')
          .select('u.signup_platform', 'platform')
          .addSelect('COUNT(*)', 'count')
          .where('u.role = :role', { role: UserRole.STUDENT })
          .groupBy('u.signup_platform')
          .getRawMany<Row>(),
        this.usersRepo
          .createQueryBuilder('u')
          .select('u.signup_platform', 'platform')
          .addSelect('COUNT(*)', 'count')
          .where('u.created_at >= :start', { start: thirtyDaysAgo })
          .andWhere('u.role = :role', { role: UserRole.STUDENT })
          .groupBy('u.signup_platform')
          .getRawMany<Row>(),
        this.loginEventsRepo
          .createQueryBuilder('e')
          .select('e.platform', 'platform')
          .addSelect('e.event_type', 'event_type')
          .addSelect('COUNT(*)', 'count')
          .innerJoin(User, 'u', 'u.id = e.user_id')
          .where('e.created_at >= :start', { start: thirtyDaysAgo })
          .andWhere('u.role = :role', { role: UserRole.STUDENT })
          .groupBy('e.platform')
          .addGroupBy('e.event_type')
          .getRawMany<EventRow>(),
        this.loginEventsRepo
          .createQueryBuilder('e')
          .select(
            "to_char(date_trunc('day', e.created_at), 'YYYY-MM-DD')",
            'day',
          )
          .addSelect('e.platform', 'platform')
          .addSelect('COUNT(*)', 'count')
          .innerJoin(User, 'u', 'u.id = e.user_id')
          .where('e.created_at >= :start', { start: thirtyDaysAgo })
          .andWhere('u.role = :role', { role: UserRole.STUDENT })
          .groupBy('day')
          .addGroupBy('e.platform')
          .orderBy('day', 'ASC')
          .getRawMany<DailyRow>(),
      ]);

    return {
      windowStart: thirtyDaysAgo.toISOString(),
      windowEnd: now.toISOString(),
      signups: {
        byPlatformAllTime: signupsAll.map((r) => ({
          platform: r.platform,
          count: parseInt(r.count, 10),
        })),
        byPlatformLast30d: signupsLast30.map((r) => ({
          platform: r.platform,
          count: parseInt(r.count, 10),
        })),
      },
      logins: {
        byPlatformLast30d: loginsByPlatform.map((r) => ({
          platform: r.platform,
          eventType: r.event_type,
          count: parseInt(r.count, 10),
        })),
        dailyLast30d: loginsDaily.map((r) => ({
          day: r.day,
          platform: r.platform,
          count: parseInt(r.count, 10),
        })),
      },
    };
  }

  /**
   * Paginated exam history for one user, ordered newest-first. The
   * shape is denormalised on the wire so the admin table can render
   * everything without a follow-up answers query: each row carries the
   * subject name list (joined from the first answer's question →
   * subject) and the on-table aggregate columns (`totalQuestions`,
   * `percentScore`, `xpEarned`, durations).
   *
   * `minutesSpent` is computed from `completed_at - started_at` when
   * the exam finished, otherwise null (in-progress exams have no
   * meaningful "time spent" until the user submits — pause/resume
   * confuses the started-at delta).
   */
  async listUserExams(
    userId: string,
    page = 1,
    limit = 20,
  ): Promise<
    PaginatedResult<{
      id: string;
      examType: string;
      mode: string;
      questionPool: string;
      status: string;
      score: number | null;
      totalQuestions: number | null;
      percentScore: string | null;
      xpEarned: number;
      durationSeconds: number | null;
      startedAt: string;
      completedAt: string | null;
      minutesSpent: number | null;
      answeredCount: number;
      correctCount: number;
      accuracy: number;
    }>
  > {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const [items, total] = await this.examsRepo.findAndCount({
      where: { userId },
      order: { startedAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    if (items.length === 0) {
      return { items: [], total, nextCursor: null };
    }

    // Per-exam answer aggregate — one query, grouped, instead of N+1.
    const examIds = items.map((e) => e.id);
    const aggregates = await this.answersRepo
      .createQueryBuilder('a')
      .select('a.exam_id', 'examId')
      .addSelect('COUNT(*)', 'answered')
      .addSelect(
        'SUM(CASE WHEN a.is_correct = true THEN 1 ELSE 0 END)',
        'correct',
      )
      .where('a.exam_id IN (:...ids)', { ids: examIds })
      .groupBy('a.exam_id')
      .getRawMany<{ examId: string; answered: string; correct: string }>();
    const aggByExam = new Map<string, { answered: number; correct: number }>();
    for (const r of aggregates) {
      aggByExam.set(r.examId, {
        answered: parseInt(r.answered, 10) || 0,
        correct: parseInt(r.correct, 10) || 0,
      });
    }

    const rows = items.map((e) => {
      const agg = aggByExam.get(e.id) ?? { answered: 0, correct: 0 };
      // Wall-clock minutes between started_at and completed_at. We
      // intentionally do NOT sum per-answer `time_spent_ms` here —
      // that's "active question time" and ignores idle gaps; the
      // wall-clock duration is what the admin cares about ("how
      // long did this session take?"). Per-answer time appears on
      // the detail endpoint.
      const minutesSpent = e.completedAt
        ? Math.max(
            0,
            Math.round(
              (e.completedAt.getTime() - e.startedAt.getTime()) / 60_000,
            ),
          )
        : null;
      return {
        id: e.id,
        examType: e.examType,
        mode: e.mode,
        questionPool: e.questionPool,
        status: e.status,
        score: e.score,
        totalQuestions: e.totalQuestions,
        percentScore: e.percentScore,
        xpEarned: e.xpEarned,
        durationSeconds: e.durationSeconds,
        startedAt: e.startedAt.toISOString(),
        completedAt: e.completedAt ? e.completedAt.toISOString() : null,
        minutesSpent,
        answeredCount: agg.answered,
        correctCount: agg.correct,
        accuracy:
          agg.answered > 0
            ? Number(((agg.correct / agg.answered) * 100).toFixed(1))
            : 0,
      };
    });

    return { items: rows, total, nextCursor: null };
  }

  /**
   * One exam in full — header summary identical to the list row, plus
   * a per-question answer table. Past-paper answers are joined to the
   * questions catalogue for the stem; PM-Test answers leave the stem
   * null today (admin would have to look the question up in the
   * Practice Made questions module to see it).
   */
  async getUserExam(
    userId: string,
    examId: string,
  ): Promise<{
    exam: {
      id: string;
      examType: string;
      mode: string;
      questionPool: string;
      status: string;
      score: number | null;
      totalQuestions: number | null;
      percentScore: string | null;
      xpEarned: number;
      durationSeconds: number | null;
      startedAt: string;
      completedAt: string | null;
      minutesSpent: number | null;
      activeStudyMinutes: number;
      answeredCount: number;
      correctCount: number;
      accuracy: number;
      subjectNames: string[];
    };
    answers: Array<{
      id: string;
      questionId: string;
      questionPool: string;
      stem: string | null;
      subjectName: string | null;
      year: number | null;
      selectedOptionId: string | null;
      selectedOptionLabel: string | null;
      correctOptionLabel: string | null;
      typedAnswer: string | null;
      isCorrect: boolean | null;
      timeSpentMs: number | null;
      explanationViewed: boolean;
      answeredAt: string;
    }>;
  }> {
    const exam = await this.examsRepo.findOne({
      where: { id: examId, userId },
    });
    if (!exam) throw new NotFoundException('Exam not found for this user');

    // Dual-pool hydration: an answer's question_id / selected_option_id
    // point into `questions`+`options` (past_paper pool) OR
    // `pm_test_questions`+`pm_test_options` (pm_test pool). The old
    // query joined only the past-paper tables, so every quiz answer
    // rendered as "(question stem unavailable)" with an empty subject
    // and a false "(skipped)" — the data was always there. Mirrors the
    // student-side review query in exams.service.
    const answers: Array<{
      id: string;
      question_id: string;
      question_pool: string;
      selected_option_id: string | null;
      typed_answer: string | null;
      is_correct: boolean | null;
      time_spent_ms: number | null;
      explanation_viewed: boolean;
      answered_at: Date;
      stem: string | null;
      subject_name: string | null;
      year: number | null;
      sel_label: string | null;
      sel_body: string | null;
      cor_label: string | null;
      cor_body: string | null;
    }> = await this.examsRepo.manager.query(
      `SELECT a.id, a.question_id, a.question_pool, a.selected_option_id,
              a.typed_answer, a.is_correct, a.time_spent_ms,
              a.explanation_viewed, a.answered_at,
              coalesce(q1.body, q2.body)   AS stem,
              coalesce(s1.name, s2.name)   AS subject_name,
              q1.year                      AS year,
              coalesce(so1.label, so2.label) AS sel_label,
              coalesce(so1.body,  so2.body)  AS sel_body,
              coalesce(co1.label, co2.label) AS cor_label,
              coalesce(co1.body,  co2.body)  AS cor_body
         FROM exam_answers a
         LEFT JOIN questions q1         ON a.question_pool = 'past_paper' AND q1.id = a.question_id
         LEFT JOIN pm_test_questions q2 ON a.question_pool = 'pm_test'    AND q2.id = a.question_id
         LEFT JOIN subjects s1          ON s1.id = q1.subject_id
         LEFT JOIN subjects s2          ON s2.id = q2.subject_id
         LEFT JOIN options so1          ON a.question_pool = 'past_paper' AND so1.id = a.selected_option_id
         LEFT JOIN pm_test_options so2  ON a.question_pool = 'pm_test'    AND so2.id = a.selected_option_id
         LEFT JOIN options co1          ON a.question_pool = 'past_paper' AND co1.question_id = q1.id AND co1.is_correct
         LEFT JOIN pm_test_options co2  ON a.question_pool = 'pm_test'    AND co2.question_id = q2.id AND co2.is_correct
        WHERE a.exam_id = $1
        ORDER BY a.answered_at ASC`,
      [examId],
    );

    // Exam-level subject names: the session's own filter first, the
    // answers' subjects as fallback (older rows may predate the filter).
    const filterIds = Array.isArray(
      (exam.subjectFilter as { subjectIds?: unknown })?.subjectIds,
    )
      ? ((exam.subjectFilter as { subjectIds: string[] }).subjectIds ?? [])
      : [];
    let subjectNames: string[] = [];
    if (filterIds.length > 0) {
      const rows: Array<{ name: string }> = await this.examsRepo.manager.query(
        `SELECT name FROM subjects WHERE id = ANY($1::uuid[]) ORDER BY name`,
        [filterIds],
      );
      subjectNames = rows.map((r) => r.name);
    }
    if (subjectNames.length === 0) {
      subjectNames = [
        ...new Set(
          answers.map((a) => a.subject_name).filter((n): n is string => !!n),
        ),
      ].sort();
    }

    const optionText = (
      label: string | null,
      body: string | null,
    ): string | null => {
      if (!label && !body) return null;
      const snippet = body ? body.slice(0, 120) : '';
      return label && snippet
        ? `${label}. ${snippet}`
        : (label ?? snippet);
    };

    const answered = answers.length;
    const correct = answers.filter((a) => a.is_correct === true).length;
    const minutesSpent = exam.completedAt
      ? Math.max(
          0,
          Math.round(
            (exam.completedAt.getTime() - exam.startedAt.getTime()) / 60_000,
          ),
        )
      : null;
    // Active-study minutes = sum of per-answer `time_spent_ms`. Differs
    // from wall-clock minutes (above) by the idle / pause gaps. Useful
    // for spotting suspiciously low engagement (e.g. 50 questions in 2
    // active minutes → likely auto-skipped).
    const activeStudyMs = answers.reduce(
      (sum, a) => sum + (a.time_spent_ms ?? 0),
      0,
    );

    return {
      exam: {
        id: exam.id,
        examType: exam.examType,
        mode: exam.mode,
        questionPool: exam.questionPool,
        status: exam.status,
        score: exam.score,
        totalQuestions: exam.totalQuestions,
        percentScore: exam.percentScore,
        xpEarned: exam.xpEarned,
        durationSeconds: exam.durationSeconds,
        startedAt: exam.startedAt.toISOString(),
        completedAt: exam.completedAt ? exam.completedAt.toISOString() : null,
        minutesSpent,
        activeStudyMinutes: Math.round(activeStudyMs / 60_000),
        answeredCount: answered,
        correctCount: correct,
        subjectNames,
        accuracy:
          answered > 0 ? Number(((correct / answered) * 100).toFixed(1)) : 0,
      },
      answers: answers.map((a) => ({
        id: a.id,
        questionId: a.question_id,
        questionPool: a.question_pool,
        stem: a.stem,
        subjectName: a.subject_name,
        year: a.year,
        selectedOptionId: a.selected_option_id,
        selectedOptionLabel: optionText(a.sel_label, a.sel_body),
        correctOptionLabel: optionText(a.cor_label, a.cor_body),
        typedAnswer: a.typed_answer,
        isCorrect: a.is_correct,
        timeSpentMs: a.time_spent_ms,
        explanationViewed: a.explanation_viewed,
        answeredAt: new Date(a.answered_at).toISOString(),
      })),
    };
  }

  /**
   * Admin patch of a user's email and/or phone. Either or both.
   * `null` explicitly clears a field; `undefined` leaves it alone.
   * Uniqueness is checked at the app layer so the admin sees a
   * friendly 400 ("already in use") instead of the DB's opaque
   * 23505 unique-violation error.
   *
   * Editing the email drops `emailVerifiedAt` — the new address
   * hasn't proven possession, and the mobile's "Verify your email"
   * banner should come back on. Phone has no equivalent verified-
   * at column today, so it stays as-is.
   */
  async updateUserContact(
    adminId: string,
    userId: string,
    dto: { email?: string | null; phone?: string | null },
    ip?: string,
  ): Promise<User> {
    // Log at handler entry so we can see what body reached the server
    // even when the request goes on to throw a 500. Values are trimmed
    // to the first 6 chars — enough to eyeball the input in ops logs
    // without pasting PII wholesale.
    this.logger.log(
      `[updateUserContact] enter adminId=${adminId} userId=${userId} emailKind=${
        dto.email === undefined
          ? 'omitted'
          : dto.email === null
            ? 'clear'
            : `set(len=${dto.email.length})`
      } phoneKind=${
        dto.phone === undefined
          ? 'omitted'
          : dto.phone === null
            ? 'clear'
            : `set(len=${dto.phone.length})`
      }`,
    );

    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const prev: Record<string, unknown> = {};
    const next: Record<string, unknown> = {};
    // Explicit patch object — we write ONLY the columns we intended
    // to touch. Bypasses TypeORM's whole-entity change tracker which
    // was our best guess for the mystery 500 (an unrelated column on
    // the loaded row failing revalidation on save).
    const patch: Partial<User> = {};

    if (dto.email !== undefined) {
      const nextEmail = dto.email ? dto.email.trim().toLowerCase() : null;
      if (nextEmail !== user.email) {
        if (nextEmail) {
          const collision = await this.usersRepo.findOne({
            where: { email: nextEmail },
          });
          if (collision && collision.id !== userId) {
            throw new BadRequestException(
              'That email address is already in use by another account.',
            );
          }
        }
        prev.email = user.email;
        next.email = nextEmail;
        patch.email = nextEmail;
        // Admin-edited email is unverified until the user proves
        // possession — nulling the timestamp re-arms the "Verify
        // your email" banner on the mobile home screen.
        patch.emailVerifiedAt = null;
        user.email = nextEmail;
        user.emailVerifiedAt = null;
      }
    }

    if (dto.phone !== undefined) {
      const nextPhone = dto.phone ? dto.phone.trim() : null;
      if (nextPhone !== user.phone) {
        if (nextPhone) {
          const collision = await this.usersRepo.findOne({
            where: { phone: nextPhone },
          });
          if (collision && collision.id !== userId) {
            throw new BadRequestException(
              'That phone number is already in use by another account.',
            );
          }
        }
        prev.phone = user.phone;
        next.phone = nextPhone;
        patch.phone = nextPhone;
        user.phone = nextPhone;
      }
    }

    // No-op guard — nothing to save, nothing to audit. Return the
    // untouched user so the client's optimistic UI still gets a
    // consistent response shape.
    if (Object.keys(next).length === 0) {
      this.logger.log(
        `[updateUserContact] no-op userId=${userId} (values already match)`,
      );
      return user;
    }

    try {
      // Explicit UPDATE only touches the fields we intended. This is
      // deliberately NOT save(user) because save() re-serializes the
      // whole entity and hits every column, which risks a 500 on any
      // unrelated column whose in-memory shape doesn't match what
      // Postgres wants (default-serialised timestamps, jsonb quirks,
      // etc.). update(id, patch) issues a bare
      // "UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?"
      // and nothing else.
      this.logger.log(
        `[updateUserContact] update userId=${userId} columns=${Object.keys(patch).join(',')}`,
      );
      await this.usersRepo.update({ id: userId }, patch);
    } catch (err) {
      // Translate the two Postgres codes that indicate a client-fixable
      // input (dup email/phone; malformed value) into a 400 with a
      // useful message. Anything else falls through as a 500, but we
      // log the code + message so server logs point at the real cause
      // instead of the bare "Internal server error" the admin sees.
      const dbErr = err as { code?: string; message?: string; detail?: string };
      const code = dbErr?.code;
      this.logger.error(
        `[updateUserContact] save failed userId=${userId} code=${code ?? 'n/a'} message=${dbErr?.message ?? 'n/a'} detail=${dbErr?.detail ?? 'n/a'}`,
      );
      if (code === '23505') {
        // Unique-violation — the DB rejected our INSERT/UPDATE because
        // the email or phone collides with another user. Our pre-check
        // above catches the common case; this fires on race conditions
        // (two admins editing the same email at the same moment) and
        // case-only variants the pre-check missed.
        throw new BadRequestException(
          'That contact detail is already in use by another account.',
        );
      }
      if (code === '23514' || code === '22001' || code === '23502') {
        // 23514: check constraint. 22001: value too long. 23502: not-null.
        // All three are DTO-layer problems that leaked past validation.
        throw new BadRequestException(
          `Invalid contact value: ${dbErr?.detail ?? dbErr?.message ?? 'unknown DB constraint'}.`,
        );
      }
      throw err;
    }

    // writeAuditLog scrubs PII from the delta (see comment on that
    // helper). We still get "admin X changed user Y's contact
    // fields at time T" for forensics; the actual old + new values
    // are redacted so the audit table stays free of the same PII
    // the users table already owns.
    //
    // Audit failure is NOT allowed to fail the contact update — the
    // user-facing change has already been persisted. Log and move on.
    try {
      await this.writeAuditLog(
        adminId,
        'user.contact_update',
        'user',
        userId,
        prev,
        next,
        ip,
      );
    } catch (err) {
      this.logger.error(
        `[updateUserContact] audit log failed userId=${userId} err=${(err as Error).message}`,
      );
    }

    return user;
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
