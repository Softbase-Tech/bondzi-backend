import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { User } from '../modules/users/entities/user.entity';
import { ExamAnswer } from '../modules/exams/entities/exam-answer.entity';
import { XpTransaction } from '../modules/xp-economy/entities/xp-transaction.entity';
import { MailService } from '../modules/mail/mail.service';
import { MailEvent } from '../modules/mail/mail.types';

/**
 * Cron: Sunday-morning weekly digest. Aggregates the last 7 days of
 * activity per user and emails a personal summary — questions answered,
 * correct rate, XP earned, current streak.
 *
 * Eligibility:
 *   - email IS NOT NULL
 *   - answered at least one question in the last 7 days (zero-activity
 *     digests are noise — we don't email people who haven't shown up)
 *
 * Batched by user with one round-trip each. Capped at 1000 sends per
 * tick: at scale this becomes a queue feed, but for the early-stage
 * userbase a single bounded loop with the per-call dry-run / Resend
 * latency is fine.
 *
 * Rank delta is intentionally a TODO placeholder (0) — wiring it
 * properly needs the leaderboard snapshot table to retain per-user
 * positions across two weeks. Filling it without the snapshot column
 * would either be a second N+1 query loop or fake data. Left at 0 so
 * the template renders cleanly and we surface the gap explicitly.
 */
@Injectable()
export class WeeklyDigestJob {
  private readonly logger = new Logger(WeeklyDigestJob.name);
  private static readonly LOCK_KEY = 17_003;

  constructor(
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    @InjectRepository(ExamAnswer)
    private readonly answersRepo: Repository<ExamAnswer>,
    @InjectRepository(XpTransaction)
    private readonly xpRepo: Repository<XpTransaction>,
    private readonly dataSource: DataSource,
    private readonly mail: MailService,
  ) {}

  // Sunday 08:00 server time. Users wake to a recap before the new week.
  @Cron('0 8 * * 0')
  async tick(): Promise<void> {
    if (process.env.WORKER_MODE !== 'true') return;
    await this.dataSource.transaction(async (em) => {
      const got = await this.tryAcquireAdvisoryLock(em);
      if (!got) {
        this.logger.log('[digest] another worker holds the lock; skipping');
        return;
      }
      await this.scan();
    });
  }

  private async scan(): Promise<void> {
    const now = Date.now();
    const weekAgo = new Date(now - 7 * 24 * 3600 * 1000);

    // Active-user shortlist: users who answered ≥1 question in the
    // last 7 days. The DISTINCT join keeps the user row out of memory
    // until we know they're worth digesting.
    const activeRows = await this.dataSource.query<
      { user_id: string }[]
    >(
      `SELECT DISTINCT e.user_id
       FROM exam_answers a
       JOIN exams e ON e.id = a.exam_id
       WHERE a.answered_at >= $1
       LIMIT 1000`,
      [weekAgo],
    );

    if (activeRows.length === 0) {
      this.logger.log('[digest] no active users in the last 7 days; skipping');
      return;
    }

    let sent = 0;
    for (const row of activeRows) {
      const stats = await this.computeStats(row.user_id, weekAgo);
      if (!stats) continue;
      sent += 1;
      await this.mail.send(MailEvent.WEEKLY_DIGEST, stats.email, {
        recipientName: stats.recipientName,
        questionsAnswered: stats.questionsAnswered,
        correctRate: stats.correctRate,
        xpThisWeek: stats.xpThisWeek,
        currentStreak: stats.currentStreak,
        // TODO: wire from leaderboard snapshots once weekly positions
        // are persisted. Zero renders as "no change" — accurate signal
        // for "we don't know yet" rather than a fabricated delta.
        rankDelta: 0,
      });
    }
    this.logger.log(`[digest] dispatched ${sent} weekly digests`);
  }

  private async computeStats(
    userId: string,
    weekAgo: Date,
  ): Promise<
    | {
        email: string;
        recipientName?: string;
        questionsAnswered: number;
        correctRate: number;
        xpThisWeek: number;
        currentStreak: number;
      }
    | null
  > {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user?.email) return null;

    // Answers in the window. We count BOTH correct AND incorrect so a
    // user who only attempts hard questions and bombs them still gets a
    // digest — the correct rate is informational, not a gate.
    const answers = await this.answersRepo
      .createQueryBuilder('a')
      .innerJoin('exams', 'e', 'e.id = a.exam_id')
      .where('e.user_id = :uid', { uid: userId })
      .andWhere('a.answered_at >= :since', { since: weekAgo })
      .select(['a.is_correct AS is_correct'])
      .getRawMany<{ is_correct: boolean | null }>();
    if (answers.length === 0) return null;
    const correct = answers.filter((a) => a.is_correct === true).length;
    const correctRate = correct / answers.length;

    // XP this week — sum of positive xp_transactions in the window.
    // Negative txs (XP redemption, refund) are intentionally excluded so
    // the digest doesn't celebrate negative motion.
    const xpRaw = await this.xpRepo
      .createQueryBuilder('x')
      .where('x.user_id = :uid', { uid: userId })
      .andWhere('x.created_at >= :since', { since: weekAgo })
      .andWhere('x.amount > 0')
      .select('COALESCE(SUM(x.amount), 0)', 'total')
      .getRawOne<{ total: string }>();
    const xpThisWeek = parseInt(xpRaw?.total ?? '0', 10);

    return {
      email: user.email,
      recipientName: user.fullName ?? undefined,
      questionsAnswered: answers.length,
      correctRate,
      xpThisWeek,
      currentStreak: user.streakDays,
    };
  }

  private async tryAcquireAdvisoryLock(em: {
    query: (sql: string, params?: unknown[]) => Promise<{ got: boolean }[]>;
  }): Promise<boolean> {
    const rows = await em.query(
      'SELECT pg_try_advisory_xact_lock(1, $1) AS got',
      [WeeklyDigestJob.LOCK_KEY],
    );
    return rows[0]?.got === true;
  }
}
