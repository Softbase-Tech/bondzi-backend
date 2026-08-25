import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StreakService } from './streak.service';
import { User } from '../users/entities/user.entity';
import { GamificationService } from './gamification.service';
import * as tz from '../../common/utils/timezone.util';

/**
 * The streak is DERIVED from `exam_answers`, not incremented.
 *
 * These tests pin that contract, because the increment version looked
 * correct in isolation and was still wrong in production: every call
 * site is best-effort (`.catch(() => void 0)`) and a duplicate answer
 * 409s before the side effects run, so a single missed bump silently
 * lowered the count forever — the next day incremented the already-wrong
 * number. Users saw "3 days in a row" printed under five filled dots.
 *
 * The `self-heals` case at the bottom is that exact bug.
 */

const TODAY = '2026-05-14'; // a Thursday

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    streakDays: 0,
    longestStreak: 0,
    lastStudyDate: null,
    ...overrides,
  } as unknown as User;
}

/** Rows as the day query returns them: `{ day: 'YYYY-MM-DD' }`. */
function days(...isoDays: string[]): Array<{ day: string }> {
  return isoDays.map((day) => ({ day }));
}

describe('StreakService', () => {
  let service: StreakService;
  let usersRepo: {
    findOne: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
    manager: { query: jest.Mock };
  };
  let updateBuilder: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    execute: jest.Mock;
  };
  let gamification: { awardXp: jest.Mock };

  beforeEach(async () => {
    // The conditional-update path goes through createQueryBuilder so the
    // "two concurrent answers can't both award streak XP" race is closed
    // at the DB level (UPDATE ... WHERE last_study_date <> today).
    updateBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    usersRepo = {
      findOne: jest.fn(),
      update: jest.fn(),
      createQueryBuilder: jest.fn(() => updateBuilder),
      // Backs `activeDaysFor` — the answer history the streak is
      // derived from. Defaults to "no prior activity".
      manager: { query: jest.fn().mockResolvedValue([]) },
    };
    gamification = { awardXp: jest.fn().mockResolvedValue(undefined) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        StreakService,
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: GamificationService, useValue: gamification },
      ],
    }).compile();
    service = moduleRef.get(StreakService);

    jest.spyOn(tz, 'accraDateIso').mockReturnValue(TODAY);
  });

  it('returns a no-op for a missing user', async () => {
    usersRepo.findOne.mockResolvedValueOnce(null);
    const out = await service.recordStudyDay('user-1');
    expect(out).toEqual({ streakDays: 0, longestStreak: 0, changed: false });
    expect(usersRepo.update).not.toHaveBeenCalled();
  });

  it('is idempotent on a same-day re-record (no XP, no DB write)', async () => {
    usersRepo.findOne.mockResolvedValueOnce(
      makeUser({ streakDays: 4, longestStreak: 7, lastStudyDate: TODAY }),
    );
    const out = await service.recordStudyDay('user-1');
    expect(out.changed).toBe(false);
    expect(out.streakDays).toBe(4);
    expect(usersRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(gamification.awardXp).not.toHaveBeenCalled();
  });

  it('aborts the bump when the conditional update affects 0 rows (concurrent winner)', async () => {
    usersRepo.findOne.mockResolvedValueOnce(
      makeUser({ streakDays: 4, lastStudyDate: '2026-05-13' }),
    );
    usersRepo.manager.query.mockResolvedValueOnce(days('2026-05-13'));
    updateBuilder.execute.mockResolvedValueOnce({ affected: 0 });
    const out = await service.recordStudyDay('user-1');
    expect(out.changed).toBe(false);
    expect(gamification.awardXp).not.toHaveBeenCalled();
  });

  it('counts the unbroken run of answer days, today included', async () => {
    usersRepo.findOne.mockResolvedValueOnce(
      makeUser({ streakDays: 6, lastStudyDate: '2026-05-13' }),
    );
    // Mon 05-08 .. Wed 05-13 is six days; today makes seven.
    usersRepo.manager.query.mockResolvedValueOnce(
      days(
        '2026-05-08',
        '2026-05-09',
        '2026-05-10',
        '2026-05-11',
        '2026-05-12',
        '2026-05-13',
      ),
    );
    const out = await service.recordStudyDay('user-1');
    expect(out.streakDays).toBe(7);
    expect(out.milestoneAwarded).toBe(7);
    // streak_day + streak_7
    expect(gamification.awardXp).toHaveBeenCalledTimes(2);
  });

  it('resets to 1 when the previous run has a gap', async () => {
    usersRepo.findOne.mockResolvedValueOnce(
      makeUser({ streakDays: 10, lastStudyDate: '2026-05-11' }),
    );
    // Last activity was three days ago — the run is dead, today starts over.
    usersRepo.manager.query.mockResolvedValueOnce(
      days('2026-05-10', '2026-05-11'),
    );
    const out = await service.recordStudyDay('user-1');
    expect(out.streakDays).toBe(1);
    expect(out.milestoneAwarded).toBeUndefined();
  });

  it('does not regress longestStreak when the new streak is shorter', async () => {
    usersRepo.findOne.mockResolvedValueOnce(
      makeUser({
        streakDays: 9,
        longestStreak: 30,
        lastStudyDate: '2026-05-09',
      }),
    );
    usersRepo.manager.query.mockResolvedValueOnce(days('2026-05-09'));
    const out = await service.recordStudyDay('user-1');
    expect(out.streakDays).toBe(1);
    expect(out.longestStreak).toBe(30);
  });

  it('non-milestone days only award the streak_day XP event', async () => {
    usersRepo.findOne.mockResolvedValueOnce(
      makeUser({ streakDays: 4, lastStudyDate: '2026-05-13' }),
    );
    usersRepo.manager.query.mockResolvedValueOnce(
      days('2026-05-11', '2026-05-12', '2026-05-13'),
    );
    await service.recordStudyDay('user-1');
    expect(gamification.awardXp).toHaveBeenCalledTimes(1);
    expect(gamification.awardXp).toHaveBeenCalledWith('user-1', 'streak_day');
  });

  it('self-heals a counter that drifted below the real run (the reported bug)', async () => {
    // Persisted counter says 3. The answer history says the student has
    // actually studied Mon-Wed and is now answering on Thursday — a real
    // 4-day run. The old increment logic would have written 4 and stayed
    // permanently one short; derivation writes the truth.
    usersRepo.findOne.mockResolvedValueOnce(
      makeUser({
        streakDays: 2,
        longestStreak: 2,
        lastStudyDate: '2026-05-13',
      }),
    );
    usersRepo.manager.query.mockResolvedValueOnce(
      days('2026-05-11', '2026-05-12', '2026-05-13'),
    );
    const out = await service.recordStudyDay('user-1');
    expect(out.streakDays).toBe(4);
    expect(out.longestStreak).toBe(4);
  });
});
