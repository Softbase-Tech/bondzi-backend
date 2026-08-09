import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { GamificationService } from './gamification.service';
import {
  accraDateIso,
  accraDaysBetween,
} from '../../common/utils/timezone.util';

const MILESTONES: Record<number, string> = {
  7: 'streak_7',
  14: 'streak_14',
  30: 'streak_30',
  50: 'streak_50',
  100: 'streak_100',
};

export interface RecordStudyDayResult {
  streakDays: number;
  longestStreak: number;
  changed: boolean;
  milestoneAwarded?: number;
}

/**
 * v2 streak tracker — called after every exam completion. Keeps today's study
 * date idempotent (multiple exams in one day don't inflate the streak), resets
 * on gap, and awards the `streak_day` XP on every streak bump plus milestone
 * bonuses at 7/14/30/50/100.
 */
@Injectable()
export class StreakService {
  private readonly logger = new Logger(StreakService.name);

  constructor(
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    private readonly gamification: GamificationService,
  ) {}

  async recordStudyDay(userId: string): Promise<RecordStudyDayResult> {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user) {
      return { streakDays: 0, longestStreak: 0, changed: false };
    }

    const today = accraDateIso();
    const last = user.lastStudyDate;

    if (last === today) {
      // Already studied today — no change, no XP award.
      return {
        streakDays: user.streakDays,
        longestStreak: user.longestStreak,
        changed: false,
      };
    }

    const nextStreak =
      last && accraDaysBetween(today, last) === 1 ? user.streakDays + 1 : 1;

    const newLongest = Math.max(user.longestStreak, nextStreak);

    // CRITICAL: conditional UPDATE bound on `last_study_date != today`
    // (or null). Two concurrent exam-completes for the same user (e.g.
    // mobile retry, dual-device race) would both read `last === yesterday`,
    // both compute nextStreak = N+1, and both write — final value is
    // correct but the streak_day XP fires twice. Only the request whose
    // UPDATE actually flipped a row may award XP; the loser sees
    // affected=0 and exits silently.
    const result = await this.usersRepo
      .createQueryBuilder()
      .update(User)
      .set({
        streakDays: nextStreak,
        longestStreak: newLongest,
        lastStudyDate: today,
      })
      .where('id = :id', { id: userId })
      .andWhere('(last_study_date is null or last_study_date <> :today)', {
        today,
      })
      .execute();

    if ((result.affected ?? 0) === 0) {
      // A concurrent request already wrote today's streak; bail and
      // return the (now stale) snapshot — caller will pick up the
      // authoritative value on next read.
      return {
        streakDays: user.streakDays,
        longestStreak: user.longestStreak,
        changed: false,
      };
    }

    await this.gamification.awardXp(userId, 'streak_day').catch((err) => {
      this.logger.warn(`streak_day XP award failed: ${(err as Error).message}`);
    });

    const milestoneEvent = MILESTONES[nextStreak];
    if (milestoneEvent) {
      await this.gamification.awardXp(userId, milestoneEvent).catch((err) => {
        this.logger.warn(
          `${milestoneEvent} XP award failed: ${(err as Error).message}`,
        );
      });
    }

    return {
      streakDays: nextStreak,
      longestStreak: newLongest,
      changed: true,
      milestoneAwarded: milestoneEvent ? nextStreak : undefined,
    };
  }
}
