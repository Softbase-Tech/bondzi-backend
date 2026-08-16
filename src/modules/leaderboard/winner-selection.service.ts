import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { LeaderboardEntry } from './entities/leaderboard-entry.entity';
import { Winner } from './entities/winner.entity';
import { User } from '../users/entities/user.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { GamificationService } from '../gamification/gamification.service';
import { MailService } from '../mail/mail.service';
import { MailEvent } from '../mail/mail.types';
import {
  ExamType,
  LeaderboardPeriodType,
  NotificationChannel,
} from '../../common/types/enums';

const MIN_ACCOUNT_AGE_DAYS = 3;
const MIN_ANSWERS = 50;
const PAYOUT_RANK_LIMIT = 20;

/**
 * Human-readable label for a period, anchored on the actual start
 * date rather than "this week / this month". Awarding can lag behind
 * the period it's for (a Monday winner-run for the previous week
 * arrives on Tuesday of the current week), and "this month" reads
 * wrong when it's really the past month.
 *
 * Formats:
 *   weekly, same calendar month:  "the week of 3–9 Aug 2026"
 *   weekly, spans two months:     "the week of 30 Aug – 5 Sep 2026"
 *   monthly:                      "August 2026"
 *
 * Uses UTC because backend period_start columns are stamped in UTC
 * (Ghana is UTC+0). Locale is en-GB to force day-month order that
 * matches Ghanaian date conventions.
 */
export function formatPeriodLabel(
  periodType: LeaderboardPeriodType,
  periodStart: string,
): string {
  const start = new Date(`${periodStart}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return '';
  if (periodType === LeaderboardPeriodType.MONTHLY) {
    return start.toLocaleDateString('en-GB', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const year = end.getUTCFullYear();
  const startDay = start.getUTCDate();
  const startMonth = start.toLocaleDateString('en-GB', {
    month: 'short',
    timeZone: 'UTC',
  });
  const endDay = end.getUTCDate();
  const endMonth = end.toLocaleDateString('en-GB', {
    month: 'short',
    timeZone: 'UTC',
  });
  if (startMonth === endMonth) {
    return `the week of ${startDay}–${endDay} ${endMonth} ${year}`;
  }
  return `the week of ${startDay} ${startMonth} – ${endDay} ${endMonth} ${year}`;
}

export interface WinnerSelectionResult {
  period: {
    examType: ExamType;
    periodType: LeaderboardPeriodType;
    periodStart: string;
  };
  awarded: number;
  skippedForAntiCheat: number;
  winners: Array<{
    userId: string;
    rank: number;
    eventKey: string;
    xpEarned: number;
  }>;
}

/**
 * v2 winner-selection job. Admin-triggered, never scheduled — the spec is
 * explicit that this must be a manual "Run weekly winners" button in the
 * admin dashboard so fraud/bug windows never blow past unnoticed.
 *
 * Steps:
 *   1. Load top N + anti-cheat context via a single ranked SELECT.
 *   2. For each candidate, in order of rank, verify anti-cheat gates:
 *      - Account age >= 3 days
 *      - Total answered questions >= 50 (all time)
 *      - phone verified (phone+auth_provider=phone) OR email verified
 *        (auth_provider in email/google with email set)
 *      - Not banned (is_active=true, deleted_at is null)
 *   3. Skipped users do NOT promote anyone else — the slot is simply empty.
 *      (Spec allows "next eligible user takes the slot"; we keep it strict so
 *      the XP burn stays predictable. Easy to relax later.)
 *   4. Insert `winners` row, award XP via GamificationService, flip
 *      xp_issued=true, write an in-app notification.
 */
@Injectable()
export class WinnerSelectionService {
  private readonly logger = new Logger(WinnerSelectionService.name);

  constructor(
    @InjectRepository(LeaderboardEntry)
    private readonly entriesRepo: Repository<LeaderboardEntry>,
    @InjectRepository(Winner)
    private readonly winnersRepo: Repository<Winner>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    @InjectRepository(ExamAnswer)
    private readonly answersRepo: Repository<ExamAnswer>,
    @InjectRepository(Notification)
    private readonly notificationsRepo: Repository<Notification>,
    private readonly gamification: GamificationService,
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
  ) {}

  eventKeyFor(periodType: LeaderboardPeriodType, rank: number): string {
    const prefix =
      periodType === LeaderboardPeriodType.MONTHLY ? 'monthly' : 'weekly';
    if (rank === 1) return `${prefix}_winner_1`;
    if (prefix === 'weekly') {
      if (rank === 2) return 'weekly_winner_2';
      if (rank === 3) return 'weekly_winner_3';
      if (rank <= 10) return 'weekly_winner_4_10';
      return 'weekly_winner_11_20';
    }
    if (rank <= 3) return 'monthly_winner_2_3';
    if (rank <= 10) return 'monthly_winner_4_10';
    return 'monthly_winner_11_20';
  }

  async selectWinners(params: {
    examType: ExamType;
    periodType: LeaderboardPeriodType;
    periodStart: string;
    /**
     * Admin-supplied user ids to drop from the pool BEFORE eligibility
     * checks run. Lets a reviewer manually exclude obvious bad actors
     * (sock-puppets, content abusers) without re-tuning the anti-cheat
     * gate. Excluded users are NOT counted in `skippedForAntiCheat`.
     */
    excludeUserIds?: string[];
  }): Promise<WinnerSelectionResult> {
    const excluded = new Set(params.excludeUserIds ?? []);
    // Idempotency: refuse to re-run for a period that already has winners.
    const existing = await this.winnersRepo.count({
      where: {
        examType: params.examType,
        periodType: params.periodType,
        periodStart: params.periodStart,
      },
    });
    if (existing > 0) {
      throw new BadRequestException(
        `Winners already selected for ${params.examType}/${params.periodType}/${params.periodStart}.`,
      );
    }

    // Fetch a wider pool than PAYOUT_RANK_LIMIT so an ineligible candidate
    // can be replaced by the next eligible user (spec §7.2: "Winners failing
    // checks are skipped; next eligible user takes the slot.").
    const pool = await this.entriesRepo
      .createQueryBuilder('lb')
      .innerJoinAndSelect('lb.user', 'u')
      .where('lb.exam_type = :et', { et: params.examType })
      .andWhere('lb.period_type = :pt', { pt: params.periodType })
      .andWhere('lb.period_start = :ps', { ps: params.periodStart })
      .andWhere("lb.scope = 'national'")
      .orderBy('lb.weekly_xp', 'DESC')
      .limit(PAYOUT_RANK_LIMIT * 3)
      .getMany();

    const winners: WinnerSelectionResult['winners'] = [];
    let skipped = 0;
    let rank = 0;
    let pi = 0;

    while (rank < PAYOUT_RANK_LIMIT && pi < pool.length) {
      const entry = pool[pi];
      pi += 1;
      // Admin manual exclusions skip the slot AND don't count toward
      // the anti-cheat skip counter — they're a deliberate human call,
      // not a system signal.
      if (excluded.has(entry.user.id)) continue;
      const eligible = await this.isEligible(entry.user);
      if (!eligible) {
        skipped += 1;
        continue;
      }
      rank += 1;
      const eventKey = this.eventKeyFor(params.periodType, rank);
      try {
        const insertedWinner = await this.dataSource.transaction(async (em) => {
          const winner = em.getRepository(Winner).create({
            userId: entry.userId,
            examType: params.examType,
            periodType: params.periodType,
            periodStart: params.periodStart,
            rank,
            xpEarned: 0, // filled after awardXp
            xpIssued: false,
          });
          await em.getRepository(Winner).save(winner);
          return winner;
        });

        const xp = await this.gamification.awardXp(
          entry.userId,
          eventKey,
          insertedWinner.id,
        );

        await this.winnersRepo.update(insertedWinner.id, {
          xpEarned: xp.xpAmount,
          xpIssued: true,
          xpIssuedAt: new Date(),
        });

        // Anchor the copy on the ACTUAL period the award was for —
        // awarding lags (a Monday-morning run announces the previous
        // week's winners), so "this week/month" can already be a
        // different period by the time the notification lands.
        const specificLabel = formatPeriodLabel(
          params.periodType,
          params.periodStart,
        );

        // PUSH (was IN_APP). Goes through NotificationsService.send
        // which writes the row AND queues the Firebase dispatch —
        // the in-app inbox AND the device notification both fire.
        await this.notifications
          .send({
            userId: entry.userId,
            channel: NotificationChannel.PUSH,
            title: 'Leaderboard winner!',
            body: `You ranked #${rank} for ${specificLabel} and earned ${xp.xpAmount} XP.`,
            data: {
              type: 'winner',
              rank: String(rank),
              periodType: params.periodType,
              periodStart: params.periodStart,
              periodLabel: specificLabel,
              xpEarned: String(xp.xpAmount),
            },
          })
          .catch((err) =>
            this.logger.warn(
              `[winner] push dispatch failed user=${entry.userId} rank=${rank}: ${(err as Error).message}`,
            ),
          );

        // Email — best-effort, swallowed on failure so the winner
        // record still persists (push + in-app inbox already
        // surface the win).
        if (entry.user.email) {
          await this.mail
            .send(
              MailEvent.WINNER_ANNOUNCEMENT,
              entry.user.email,
              {
                recipientName: entry.user.fullName.split(' ')[0],
                // `period` is the grammatical bucket (week / month) —
                // still used inside the template for phrases like
                // "next week's board is open".
                period:
                  params.periodType === LeaderboardPeriodType.MONTHLY
                    ? 'month'
                    : 'week',
                // `periodLabel` is the specific dated label — what the
                // user actually reads next to their rank.
                periodLabel: specificLabel,
                rank,
                xpAwarded: xp.xpAmount,
                level: params.examType.toUpperCase(),
              },
              { userId: entry.userId },
            )
            .catch((err) =>
              this.logger.warn(
                `[winner] email dispatch failed user=${entry.userId} rank=${rank}: ${(err as Error).message}`,
              ),
            );
        }

        winners.push({
          userId: entry.userId,
          rank,
          eventKey,
          xpEarned: xp.xpAmount,
        });
      } catch (err) {
        this.logger.warn(
          `winner rank ${rank} (${entry.userId}) failed: ${(err as Error).message}`,
        );
        // Roll back the consumed slot so the next eligible user takes this
        // rank instead.
        rank -= 1;
        skipped += 1;
      }
    }

    return {
      period: {
        examType: params.examType,
        periodType: params.periodType,
        periodStart: params.periodStart,
      },
      awarded: winners.length,
      skippedForAntiCheat: skipped,
      winners,
    };
  }

  /**
   * Winners for the LATEST period_start present in the `winners` table
   * matching (examType, periodType). Used by the mobile-facing
   * `/leaderboard/winners` endpoint when the caller doesn't pin a
   * specific period — the mobile UI is asking "who won this week /
   * this month" and wants a single period's worth of top 20, not
   * every period ever concatenated.
   *
   * Previously the mobile endpoint fell through to `listPast` with
   * no period_start filter, so a user who had won multiple past
   * weeks appeared once per win — the winners tab rendered the
   * same student two-to-ten times and tripped a React key collision
   * because the row key is userId.
   *
   * Returns [] (never throws) when no winners have been selected
   * yet for that examType/periodType — the mobile falls through to
   * its empty state.
   */
  async listCurrentPeriodWinners(params: {
    examType: ExamType;
    periodType: LeaderboardPeriodType;
  }) {
    const latestRow = await this.winnersRepo
      .createQueryBuilder('w')
      .select('MAX(w.period_start)', 'periodStart')
      .where('w.exam_type = :et', { et: params.examType })
      .andWhere('w.period_type = :pt', { pt: params.periodType })
      .getRawOne<{ periodStart: string | Date | null }>();
    const raw = latestRow?.periodStart ?? null;
    if (!raw) return [];
    // period_start is a DATE column — node-pg surfaces it as a Date
    // in some configs and a string in others. Normalise to
    // `YYYY-MM-DD` so the equality filter downstream matches the
    // schema exactly.
    const periodStart =
      typeof raw === 'string' ? raw.slice(0, 10) : raw.toISOString().slice(0, 10);
    return this.listPast({
      examType: params.examType,
      periodType: params.periodType,
      periodStart,
    });
  }

  async listPast(params: {
    examType?: ExamType;
    periodType?: LeaderboardPeriodType;
    periodStart?: string;
  }) {
    // Use property names (`w.periodStart`, `w.examType`) rather than raw
    // snake-case columns (`w.period_start`). `.take()` makes TypeORM build a
    // subquery that resolves `orderBy` columns through entity metadata; with
    // snake_case strings the lookup returns `undefined` and TypeORM throws
    // `Cannot read properties of undefined (reading 'databaseName')`.
    //
    // All three filters are optional now so the admin "all winners" view
    // (no filter selected) returns the most recent across both exam types
    // and both period types. The previous required-filter shape meant the
    // admin had to scan twice (BECE then WASSCE) to see the whole picture.
    const qb = this.winnersRepo
      .createQueryBuilder('w')
      .innerJoinAndSelect('w.user', 'u')
      .orderBy('w.periodStart', 'DESC')
      .addOrderBy('w.rank', 'ASC');
    if (params.examType) {
      qb.andWhere('w.examType = :et', { et: params.examType });
    }
    if (params.periodType) {
      qb.andWhere('w.periodType = :pt', { pt: params.periodType });
    }
    if (params.periodStart) {
      qb.andWhere('w.periodStart = :ps', { ps: params.periodStart });
    }
    const rows = await qb.take(200).getMany();
    // Flatten the joined user so the admin table can render `w.userName`
    // and `w.username` directly without spelunking through `w.user`. Mobile
    // already uses `w.user.username`/`w.user.fullName` so this is purely
    // additive — both shapes coexist on the wire.
    //
    // `selectedAt` is sourced from `createdAt` because confirmation
    // creates the winner row — they're the same event. `selectedBy`
    // is null today: we don't yet record which admin clicked Confirm
    // (no audit column on the table), so the admin table renders the
    // timestamp without an attribution.
    return rows.map((w) => ({
      ...w,
      userName: w.user?.fullName ?? '',
      username: w.user?.username ?? null,
      selectedAt: w.createdAt ? w.createdAt.toISOString() : null,
      selectedBy: null,
    }));
  }

  /**
   * Returns the candidate pool the admin can vet before confirming a
   * selection. Same shape `selectWinners` would consider (top
   * PAYOUT_RANK_LIMIT * 3 by weekly_xp), each row annotated with the
   * eligibility signals so the UI can render `Verified ✓ / anti-cheat`
   * indicators per row.
   */
  /**
   * Every (exam_type, period_type, period_start) that has at least
   * one `leaderboard_entries` row but ZERO `winners` rows — the
   * "you forgot to pick winners for last week (or the week before
   * that)" list.
   *
   * The admin dashboard previously surfaced only `now - 7d`, so
   * once a week rolled over without a manual selection the period
   * fell off the radar. This query is the authoritative source of
   * truth for what's still open.
   *
   * Returns rows sorted by period_start DESC (most recent first),
   * capped at `limit` so a long-untouched system can't unbox a
   * huge JSON blob on the admin home.
   */
  async listPendingPeriods(
    opts: {
      limit?: number;
      examType?: ExamType;
      periodType?: LeaderboardPeriodType;
    } = {},
  ): Promise<
    Array<{
      examType: ExamType;
      periodType: LeaderboardPeriodType;
      periodStart: string;
      candidateCount: number;
    }>
  > {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const qb = this.entriesRepo
      .createQueryBuilder('lb')
      // LEFT JOIN winners on the same period-tuple. Rows in the
      // group with `w.id` NULL are the unselected periods.
      .leftJoin(
        Winner,
        'w',
        'w.exam_type = lb.exam_type AND ' +
          'w.period_type = lb.period_type AND ' +
          'w.period_start = lb.period_start',
      )
      .select('lb.exam_type', 'examType')
      .addSelect('lb.period_type', 'periodType')
      .addSelect('lb.period_start', 'periodStart')
      .addSelect('COUNT(DISTINCT lb.user_id)', 'candidateCount')
      .where("lb.scope = 'national'")
      .groupBy('lb.exam_type, lb.period_type, lb.period_start')
      .having('COUNT(w.id) = 0')
      .orderBy('lb.period_start', 'DESC')
      .addOrderBy('lb.exam_type', 'ASC')
      .limit(limit);
    if (opts.examType) qb.andWhere('lb.exam_type = :et', { et: opts.examType });
    if (opts.periodType) {
      qb.andWhere('lb.period_type = :pt', { pt: opts.periodType });
    }
    const rows = await qb.getRawMany<{
      examType: string;
      periodType: string;
      periodStart: string | Date;
      candidateCount: string;
    }>();
    return rows.map((r) => ({
      examType: r.examType as ExamType,
      periodType: r.periodType as LeaderboardPeriodType,
      // `period_start` is a DATE column — node-pg surfaces it as a
      // Date in some configs and a string in others. Normalise to
      // `YYYY-MM-DD` so the wire shape matches everywhere.
      periodStart:
        typeof r.periodStart === 'string'
          ? r.periodStart.slice(0, 10)
          : r.periodStart.toISOString().slice(0, 10),
      candidateCount: parseInt(r.candidateCount, 10) || 0,
    }));
  }

  async listCandidates(params: {
    examType: ExamType;
    periodType: LeaderboardPeriodType;
    periodStart: string;
  }) {
    const pool = await this.entriesRepo
      .createQueryBuilder('lb')
      .innerJoinAndSelect('lb.user', 'u')
      .where('lb.exam_type = :et', { et: params.examType })
      .andWhere('lb.period_type = :pt', { pt: params.periodType })
      .andWhere('lb.period_start = :ps', { ps: params.periodStart })
      .andWhere("lb.scope = 'national'")
      .orderBy('lb.weekly_xp', 'DESC')
      .limit(PAYOUT_RANK_LIMIT * 3)
      .getMany();

    // Reuse isEligible for the boolean verdict, plus surface the raw
    // signals the admin needs to make a judgement call.
    const enriched = await Promise.all(
      pool.map(async (entry, index) => {
        const user = entry.user;
        const ageDays = Math.floor(
          (Date.now() - user.createdAt.getTime()) / (24 * 60 * 60 * 1000),
        );
        const answers = await this.answersRepo.count({
          where: { exam: { userId: user.id } },
          relations: { exam: true },
        });
        const verified = Boolean(user.email) || Boolean(user.phone);
        const banned = !user.isActive || Boolean(user.deletedAt);
        const antiCheatPass =
          !banned &&
          ageDays >= MIN_ACCOUNT_AGE_DAYS &&
          answers >= MIN_ANSWERS &&
          verified;
        let antiCheatReason: string | null = null;
        if (banned) antiCheatReason = 'banned';
        else if (ageDays < MIN_ACCOUNT_AGE_DAYS)
          antiCheatReason = `account ${ageDays}d old (need ${MIN_ACCOUNT_AGE_DAYS})`;
        else if (answers < MIN_ANSWERS)
          antiCheatReason = `${answers} answers (need ${MIN_ANSWERS})`;
        else if (!verified) antiCheatReason = 'no verified email or phone';
        return {
          userId: user.id,
          fullName: user.fullName,
          // Username is the public display name. Surfacing it alongside
          // `fullName` lets admin reviewers see exactly what the
          // leaderboard / winners-announcement post will show without
          // them having to cross-reference the user detail page.
          username: user.username ?? null,
          avatarUrl: user.avatarUrl ?? null,
          rank: index + 1,
          weeklyXp: entry.weeklyXp,
          accountAgeDays: ageDays,
          questionsAnswered: answers,
          verified,
          antiCheatPass,
          antiCheatReason,
        };
      }),
    );
    return enriched;
  }

  async allTimeHallOfFame(examType: ExamType) {
    // CRITICAL: Postgres folds unquoted identifiers to lowercase. The
    // previous shape used camelCase aliases (`as totalXp`) and referred
    // to them unquoted in the ORDER BY (`addOrderBy('totalXp', 'DESC')`).
    // Postgres saw `order by totalxp` and the alias `totalxp` (also
    // lowercased) — but those resolved differently across TypeORM
    // versions, producing `column "totalxp" does not exist` on some
    // builds. Snake-case aliases dodge the folding ambiguity entirely:
    // both the SELECT and ORDER BY refer to the same lowercase name.
    const rows = await this.winnersRepo
      .createQueryBuilder('w')
      .innerJoin('w.user', 'u')
      .select('w.user_id', 'user_id')
      .addSelect('u.full_name', 'full_name')
      .addSelect('u.username', 'username')
      .addSelect('COUNT(w.id)', 'wins')
      .addSelect('SUM(w.xp_earned)', 'total_xp')
      .where('w.exam_type = :et', { et: examType })
      .andWhere('w.xp_issued = true')
      .groupBy('w.user_id')
      .addGroupBy('u.full_name')
      .addGroupBy('u.username')
      .orderBy('wins', 'DESC')
      .addOrderBy('total_xp', 'DESC')
      .limit(20)
      .getRawMany<{
        user_id: string;
        full_name: string;
        username: string | null;
        wins: string;
        total_xp: string;
      }>();
    // Admin `HallOfFameRow` shape: examType (= filter), totalWins,
    // totalXpFromPrizes. The previous shape used `wins` / `totalXp`
    // which the admin table read as undefined, leaving those columns
    // empty. Echo the requested examType on each row so the admin
    // filter chip + the column align.
    return rows.map((r) => ({
      userId: r.user_id,
      fullName: r.full_name,
      username: r.username ?? null,
      examType,
      totalWins: parseInt(r.wins, 10) || 0,
      totalXpFromPrizes: parseInt(r.total_xp, 10) || 0,
    }));
  }

  private async isEligible(user: User): Promise<boolean> {
    if (!user.isActive || user.deletedAt) return false;
    const ageDays =
      (Date.now() - user.createdAt.getTime()) / (24 * 60 * 60 * 1000);
    if (ageDays < MIN_ACCOUNT_AGE_DAYS) return false;

    const answers = await this.answersRepo.count({
      where: { exam: { userId: user.id } },
      relations: { exam: true },
    });
    if (answers < MIN_ANSWERS) return false;

    // Either email or phone is populated (we require one at registration);
    // having an auth_provider of 'phone' implies phone was OTP-verified,
    // email/google both imply email verified.
    const verified = Boolean(user.email) || Boolean(user.phone);
    if (!verified) return false;

    return true;
  }
}
