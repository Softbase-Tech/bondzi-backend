import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { accraDateIso } from '../../common/utils/timezone.util';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { UsersService } from './users.service';
import { User } from './entities/user.entity';
import { UserSubject } from './entities/user-subject.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { UserSubjectProgress } from '../progress/entities/user-subject-progress.entity';
import { Exam } from '../exams/entities/exam.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import * as passwordUtil from '../../common/utils/password.util';

/**
 * UsersService specs.
 *
 *   - getMe / getProgress: 404 on unknown user, joins subscription + progress.
 *   - updateProfile: 404 on unknown user, otherwise Object.assign + save.
 *   - changePassword: verifies current, refuses identical new, hashes + saves.
 *   - getStats: parses the raw aggregate string columns into numbers and
 *     applies the spec's dailyGoal cap so a heavy day can't return >20.
 */

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    fullName: 'Jane',
    email: 'jane@example.com',
    passwordHash: 'argon2-hash',
    region: null,
    schoolName: null,
    examType: 'wassce',
    formLevel: 3,
    isActive: true,
    ...overrides,
  } as unknown as User;
}

describe('UsersService', () => {
  let service: UsersService;
  let usersRepo: {
    findOne: jest.Mock;
    save: jest.Mock;
    softDelete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let subsRepo: { findOne: jest.Mock };
  let progressRepo: { find: jest.Mock };
  let answersRepo: { createQueryBuilder: jest.Mock };

  beforeEach(async () => {
    usersRepo = {
      findOne: jest.fn(),
      save: jest.fn(async (u: User) => u),
      softDelete: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    subsRepo = { findOne: jest.fn() };
    progressRepo = { find: jest.fn() };
    answersRepo = { createQueryBuilder: jest.fn() };
    const examsRepo = {} as never;
    const subjectsRepo = { find: jest.fn() };
    const userSubjectsRepo = {
      find: jest.fn(),
      delete: jest.fn(),
      insert: jest.fn(),
    };
    const dataSource = {
      transaction: jest.fn(async (fn: (em: unknown) => Promise<unknown>) =>
        fn({
          getRepository: () => userSubjectsRepo,
        }),
      ),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: getRepositoryToken(Subscription), useValue: subsRepo },
        {
          provide: getRepositoryToken(UserSubjectProgress),
          useValue: progressRepo,
        },
        { provide: getRepositoryToken(Exam), useValue: examsRepo },
        { provide: getRepositoryToken(ExamAnswer), useValue: answersRepo },
        { provide: getRepositoryToken(Subject), useValue: subjectsRepo },
        {
          provide: getRepositoryToken(UserSubject),
          useValue: userSubjectsRepo,
        },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = moduleRef.get(UsersService);
  });

  // ------------------------------ getMe ------------------------------

  describe('getMe', () => {
    it('throws NotFound when user does not exist', async () => {
      usersRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.getMe('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns user + subscription + progress on success', async () => {
      usersRepo.findOne.mockResolvedValueOnce(makeUser());
      subsRepo.findOne.mockResolvedValueOnce({ id: 'sub-1' });
      progressRepo.find.mockResolvedValueOnce([{ subjectId: 's' }]);
      const out = await service.getMe('user-1');
      expect(out.user.id).toBe('user-1');
      expect(out.subscription).toEqual({ id: 'sub-1' });
      expect(out.progress).toHaveLength(1);
    });
  });

  // --------------------------- updateProfile ---------------------------

  describe('updateProfile', () => {
    it('throws NotFound when user does not exist', async () => {
      usersRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.updateProfile('missing', { region: 'Greater Accra' } as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('persists provided fields and leaves others alone', async () => {
      usersRepo.findOne.mockResolvedValueOnce(makeUser({ region: 'Ashanti' }));
      const out = await service.updateProfile('user-1', {
        region: 'Greater Accra',
      } as never);
      expect(out.region).toBe('Greater Accra');
      expect(out.examType).toBe('wassce'); // untouched
      expect(usersRepo.save).toHaveBeenCalled();
    });
  });

  // -------------------------- changePassword --------------------------

  describe('changePassword', () => {
    function stubQbReturns(user: User | null) {
      usersRepo.createQueryBuilder.mockReturnValueOnce({
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(user),
      });
    }

    it('rejects when the user has no password (e.g. Google-only account)', async () => {
      stubQbReturns(makeUser({ passwordHash: null as never }));
      await expect(
        service.changePassword('user-1', {
          currentPassword: 'x',
          newPassword: 'y',
        } as never),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects when the current password is wrong', async () => {
      stubQbReturns(makeUser());
      jest.spyOn(passwordUtil, 'verifyPassword').mockResolvedValueOnce(false);
      await expect(
        service.changePassword('user-1', {
          currentPassword: 'wrong',
          newPassword: 'NewStrong123',
        } as never),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects when the new password equals the current one', async () => {
      stubQbReturns(makeUser());
      jest.spyOn(passwordUtil, 'verifyPassword').mockResolvedValueOnce(true);
      await expect(
        service.changePassword('user-1', {
          currentPassword: 'same',
          newPassword: 'same',
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('hashes and persists the new password on success', async () => {
      stubQbReturns(makeUser());
      jest.spyOn(passwordUtil, 'verifyPassword').mockResolvedValueOnce(true);
      jest
        .spyOn(passwordUtil, 'hashPassword')
        .mockResolvedValueOnce('new-hash');
      await service.changePassword('user-1', {
        currentPassword: 'old',
        newPassword: 'NewStrong123',
      } as never);
      expect(usersRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ passwordHash: 'new-hash' }),
      );
    });
  });

  // ----------------------------- getStats -----------------------------

  describe('getStats', () => {
    function stubUserAndAggregate(
      row: Record<string, string> | null,
      userOverrides: Partial<User> = {},
      /** Distinct Accra days with >=1 answer, newest first. */
      activeDays: string[] = [],
    ) {
      usersRepo.findOne.mockResolvedValueOnce(
        makeUser({
          streakDays: 0,
          longestStreak: 0,
          lastStudyDate: null,
          levelXp: '0',
          currentLevel: 1,
          ...userOverrides,
        }),
      );
      answersRepo.createQueryBuilder.mockReturnValueOnce({
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        setParameters: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue(row),
      });
      // ONE query now backs both `activeDaysLast7` and `streakDays` —
      // they are derived from the same rows so they cannot disagree.
      // Defaults to "no activity"; streak tests pass an explicit list.
      (answersRepo as unknown as { manager: { query: jest.Mock } }).manager = {
        query: jest.fn().mockResolvedValue(activeDays.map((day) => ({ day }))),
      };
    }

    it('returns zero-state when the user has no exam answers', async () => {
      stubUserAndAggregate(null);
      const out = await service.getStats('user-1');
      expect(out.totalQuestionsAttempted).toBe(0);
      expect(out.accuracy).toBe(0);
      expect(out.xp).toBe(0);
      expect(out.level).toBe(1);
      expect(out.streakDays).toBe(0);
      expect(out.activeDaysLast7).toEqual([
        false,
        false,
        false,
        false,
        false,
        false,
        false,
      ]);
    });

    it('computes accuracy as a 0-100 rounded-1dp number', async () => {
      stubUserAndAggregate({
        total: '40',
        correct: '30',
        timeMs: '0',
        today: '0',
        week: '0',
        todayMs: '0',
      });
      const out = await service.getStats('user-1');
      expect(out.totalQuestionsAttempted).toBe(40);
      expect(out.accuracy).toBe(75);
    });

    it('caps dailyGoalProgress at the configured dailyGoal (20)', async () => {
      stubUserAndAggregate({
        total: '100',
        correct: '90',
        timeMs: '0',
        today: '50', // user smashed today
        week: '50',
        todayMs: '0',
      });
      const out = await service.getStats('user-1');
      expect(out.dailyGoalProgress).toBe(20);
    });

    it('returns studyMinutesToday converted from ms', async () => {
      stubUserAndAggregate({
        total: '1',
        correct: '0',
        timeMs: '0',
        today: '1',
        week: '1',
        todayMs: '600000', // 10 minutes
      });
      const out = await service.getStats('user-1');
      expect(out.studyMinutesToday).toBe(10);
    });

    it('reports xp + level from the persisted user.levelXp / currentLevel', async () => {
      // /users/me/stats now reads the canonical XP wallet off the User
      // row — the legacy `correct * 10` recompute used a different level
      // curve than gamification/level.util and drifted from /auth/me.
      stubUserAndAggregate(
        {
          total: '20',
          correct: '15',
          timeMs: '0',
          today: '0',
          week: '0',
          todayMs: '0',
        },
        { levelXp: '300', currentLevel: 3 },
      );
      const out = await service.getStats('user-1');
      expect(out.xp).toBe(300);
      expect(out.level).toBe(3);
    });

    it('derives the streak from answer history, ignoring a drifted counter', async () => {
      // THE REPORTED BUG. The persisted counter said 3 while the week
      // dots showed 5 filled days, because the two read different
      // sources. They now read the same rows, so the number is the
      // length of the trailing run in that set — whatever the stale
      // column happens to say.
      const today = accraDateIso();
      const day = (back: number): string => {
        const d = new Date(`${today}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - back);
        return d.toISOString().slice(0, 10);
      };
      stubUserAndAggregate(
        {
          total: '0',
          correct: '0',
          timeMs: '0',
          today: '0',
          week: '0',
          todayMs: '0',
        },
        { streakDays: 3, longestStreak: 3, lastStudyDate: day(4) },
        [day(0), day(1), day(2), day(3), day(4)],
      );
      const out = await service.getStats('user-1');
      expect(out.streakDays).toBe(5);
      // The all-time record can't be lower than a run we can see.
      expect(out.longestStreak).toBe(5);
      expect(out.lastStudyDate).toBe(day(0));
      expect(out.streakBroken).toBe(false);
    });

    it('keeps a persisted longestStreak that exceeds the visible window', async () => {
      stubUserAndAggregate(
        {
          total: '0',
          correct: '0',
          timeMs: '0',
          today: '0',
          week: '0',
          todayMs: '0',
        },
        { streakDays: 0, longestStreak: 30, lastStudyDate: '2020-01-01' },
      );
      const out = await service.getStats('user-1');
      expect(out.streakDays).toBe(0);
      expect(out.longestStreak).toBe(30);
    });

    it('throws NotFound when the user does not exist', async () => {
      usersRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.getStats('ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // -------------------------- softDelete --------------------------

  it('softDelete delegates to TypeORM softDelete', async () => {
    await service.softDelete('user-1');
    expect(usersRepo.softDelete).toHaveBeenCalledWith({ id: 'user-1' });
  });

  // ------------------------- getProgress -------------------------

  it('getProgress passes the subject relation hint', async () => {
    progressRepo.find.mockResolvedValueOnce([]);
    await service.getProgress('user-1');
    expect(progressRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        relations: ['subject'],
      }),
    );
  });
});
