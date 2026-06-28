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
 * activity per user and emails a personal summary.
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
    const weekKey = weekAgo.toISOString().slice(0, 10);

    const activeRows = await this.dataSource.query<{ user_id: string }[]>(
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

    let queued = 0;
    for (const row of activeRows) {
      const stats = await this.computeStats(row.user_id, weekAgo);
      if (!stats) continue;
      queued += 1;
      const unsubscribeUrl = stats.unsubscribeToken
        ? this.mail.buildUnsubscribeUrl(stats.unsubscribeToken)
        : undefined;
      await this.mail.send(
        MailEvent.WEEKLY_DIGEST,
        stats.email,
        {
          recipientName: stats.recipientName,
          questionsAnswered: stats.questionsAnswered,
          correctRate: stats.correctRate,
          xpThisWeek: stats.xpThisWeek,
          currentStreak: stats.currentStreak,
          rankDelta: 0,
          unsubscribeUrl,
        },
        {
          userId: row.user_id,
          dedupKey: `weekly_digest:${row.user_id}:${weekKey}`,
          sync: false,
        },
      );
    }
    this.logger.log(`[digest] queued ${queued} weekly digests`);
  }

  private async computeStats(
    userId: string,
    weekAgo: Date,
  ): Promise<{
    email: string;
    recipientName?: string;
    questionsAnswered: number;
    correctRate: number;
    xpThisWeek: number;
    currentStreak: number;
    unsubscribeToken: string | null;
  } | null> {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user?.email) return null;

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
      unsubscribeToken: user.emailUnsubscribeToken,
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
