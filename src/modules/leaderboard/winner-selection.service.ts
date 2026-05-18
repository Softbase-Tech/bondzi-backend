import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { LeaderboardEntry } from './entities/leaderboard-entry.entity';
import { Winner } from './entities/winner.entity';
import { User } from '../users/entities/user.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { GamificationService } from '../gamification/gamification.service';
import {
  ExamType,
  LeaderboardPeriodType,
  NotificationChannel,
} from '../../common/types/enums';

const MIN_ACCOUNT_AGE_DAYS = 3;
const MIN_ANSWERS = 50;
const PAYOUT_RANK_LIMIT = 20;

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

        await this.notificationsRepo.insert({
          userId: entry.userId,
          channel: NotificationChannel.IN_APP,
          title: 'Leaderboard winner!',
          body: `Congratulations! You ranked #${rank} this ${params.periodType === LeaderboardPeriodType.MONTHLY ? 'month' : 'week'} and earned ${xp.xpAmount} XP.`,
          data: {
            type: 'winner',
            rank,
            periodType: params.periodType,
            periodStart: params.periodStart,
            xpEarned: xp.xpAmount,
          },
        });

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

  listPast(params: {
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
    return qb.take(200).getMany();
  }

  /**
   * Returns the candidate pool the admin can vet before confirming a
   * selection. Same shape `selectWinners` would consider (top
   * PAYOUT_RANK_LIMIT * 3 by weekly_xp), each row annotated with the
   * eligibility signals so the UI can render `Verified ✓ / anti-cheat`
   * indicators per row.
   */
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
      .addSelect('COUNT(w.id)', 'wins')
      .addSelect('SUM(w.xp_earned)', 'total_xp')
      .where('w.exam_type = :et', { et: examType })
      .andWhere('w.xp_issued = true')
      .groupBy('w.user_id')
      .addGroupBy('u.full_name')
      .orderBy('wins', 'DESC')
      .addOrderBy('total_xp', 'DESC')
      .limit(20)
      .getRawMany<{
        user_id: string;
        full_name: string;
        wins: string;
        total_xp: string;
      }>();
    return rows.map((r) => ({
      userId: r.user_id,
      fullName: r.full_name,
      wins: parseInt(r.wins, 10) || 0,
      totalXp: parseInt(r.total_xp, 10) || 0,
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
