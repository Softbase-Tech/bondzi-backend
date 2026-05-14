import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StreakService } from './streak.service';
import { User } from '../users/entities/user.entity';
import { GamificationService } from './gamification.service';
import * as tz from '../../common/utils/timezone.util';

/**
 *  - Same-day idempotency: a second exam on the same day doesn't bump the
 *    streak counter and doesn't trigger duplicate XP.
 *  - Continuation (last study = yesterday) increments by 1.
 *  - Gap (last study > 1 day ago) resets the counter to 1.
 *  - longestStreak only moves upward.
 *  - Milestones (7 / 14 / 30 / 50 / 100) award the milestone XP event.
 *  - User missing → no-op response.
 */

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    streakDays: 0,
    longestStreak: 0,
    lastStudyDate: null,
    ...overrides,
  } as unknown as User;
}

describe('StreakService', () => {
  let service: StreakService;
  let usersRepo: { findOne: jest.Mock; update: jest.Mock };
  let gamification: { awardXp: jest.Mock };

  beforeEach(async () => {
    usersRepo = { findOne: jest.fn(), update: jest.fn() };
    gamification = { awardXp: jest.fn().mockResolvedValue(undefined) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        StreakService,
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: GamificationService, useValue: gamification },
      ],
    }).compile();
    service = moduleRef.get(StreakService);

    jest.spyOn(tz, 'accraDateIso').mockReturnValue('2026-05-14');
  });

  it('returns a no-op for a missing user', async () => {
    usersRepo.findOne.mockResolvedValueOnce(null);
    const out = await service.recordStudyDay('user-1');
    expect(out).toEqual({ streakDays: 0, longestStreak: 0, changed: false });
    expect(usersRepo.update).not.toHaveBeenCalled();
  });

  it('is idempotent on a same-day re-record (no XP, no DB write)', async () => {
    usersRepo.findOne.mockResolvedValueOnce(
      makeUser({
        streakDays: 4,
        longestStreak: 7,
        lastStudyDate: '2026-05-14',
      }),
    );
    const out = await service.recordStudyDay('user-1');
    expect(out.changed).toBe(false);
    expect(out.streakDays).toBe(4);
    expect(usersRepo.update).not.toHaveBeenCalled();
    expect(gamification.awardXp).not.toHaveBeenCalled();
  });

  it('continues the streak when last study was exactly yesterday', async () => {
    jest.spyOn(tz, 'accraDaysBetween').mockReturnValueOnce(1);
    usersRepo.findOne.mockResolvedValueOnce(
      makeUser({ streakDays: 6, lastStudyDate: '2026-05-13' }),
    );
    const out = await service.recordStudyDay('user-1');
    expect(out.streakDays).toBe(7);
    expect(out.milestoneAwarded).toBe(7); // 7-day milestone
    // streak_day + streak_7 awards.
    expect(gamification.awardXp).toHaveBeenCalledTimes(2);
  });

  it('resets the streak to 1 when there is a gap of more than one day', async () => {
    jest.spyOn(tz, 'accraDaysBetween').mockReturnValueOnce(3);
    usersRepo.findOne.mockResolvedValueOnce(
      makeUser({ streakDays: 10, lastStudyDate: '2026-05-11' }),
    );
    const out = await service.recordStudyDay('user-1');
    expect(out.streakDays).toBe(1);
    expect(out.milestoneAwarded).toBeUndefined();
  });

  it('does not regress longestStreak when the new streak is shorter', async () => {
    jest.spyOn(tz, 'accraDaysBetween').mockReturnValueOnce(5);
    usersRepo.findOne.mockResolvedValueOnce(
      makeUser({ streakDays: 9, longestStreak: 30, lastStudyDate: '2026-05-09' }),
    );
    const out = await service.recordStudyDay('user-1');
    expect(out.streakDays).toBe(1);
    expect(out.longestStreak).toBe(30);
  });

  it('non-milestone days only award the streak_day XP event', async () => {
    jest.spyOn(tz, 'accraDaysBetween').mockReturnValueOnce(1);
    usersRepo.findOne.mockResolvedValueOnce(
      makeUser({ streakDays: 4, lastStudyDate: '2026-05-13' }),
    );
    await service.recordStudyDay('user-1');
    expect(gamification.awardXp).toHaveBeenCalledTimes(1);
    expect(gamification.awardXp).toHaveBeenCalledWith('user-1', 'streak_day');
  });
});
