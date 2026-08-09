import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ReferralsService } from './referrals.service';
import { ReferralEvent } from './entities/referral-event.entity';
import { User } from '../users/entities/user.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import { XpTransaction } from '../xp-economy/entities/xp-transaction.entity';
import { GamificationService } from '../gamification/gamification.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RedisService } from '../../common/redis/redis.service';

/**
 *  - issueSignupRewards: no-op when no pending event, otherwise awards XP
 *    both sides and flips signupXpIssued.
 *  - checkQualification: no-op below 10 answers; at the threshold it
 *    promotes referral_qualified, awards the qualifier XP and sends a
 *    push to the referrer.
 *  - statsForUser: aggregates referred / qualified counts and derives
 *    pendingCount = referred - qualified.
 *  - listEvents reads with newest-first ordering.
 */

describe('ReferralsService', () => {
  let service: ReferralsService;
  let eventsRepo: {
    findOne: jest.Mock;
    count: jest.Mock;
    update: jest.Mock;
    find: jest.Mock;
    // `checkQualification` now SELECT FOR UPDATE-locks the event row
    // inside the tx (fixes the TOCTOU between count and update that
    // double-awarded `referral_qualified` XP under concurrent writes).
    createQueryBuilder: jest.Mock;
  };
  let usersRepo: { findOne: jest.Mock };
  // `checkQualification` now uses `answersRepo.manager.query` for the
  // count (one SQL round-trip; the previous TypeORM count-with-relations
  // was an N+1 hot spot fired on every answer submit).
  let answersRepo: {
    count: jest.Mock;
    manager: { query: jest.Mock };
  };
  let xpTxRepo: { findOne: jest.Mock };
  let gamification: { awardXp: jest.Mock };
  let notifications: { send: jest.Mock };
  let redis: Record<string, unknown>;
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    eventsRepo = {
      findOne: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      find: jest.fn(),
      // Default: locked row exists, qualifyXpIssued=false → tx proceeds.
      createQueryBuilder: jest.fn(() => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ qualifyXpIssued: false }),
      })),
    };
    usersRepo = { findOne: jest.fn(), update: jest.fn() } as never;
    answersRepo = {
      count: jest.fn(),
      manager: { query: jest.fn() },
    };
    xpTxRepo = { findOne: jest.fn() };
    gamification = { awardXp: jest.fn() };
    notifications = { send: jest.fn().mockResolvedValue(undefined) };
    redis = {};
    // transaction(fn) runs the callback against a fake entity manager whose
    // getRepository returns the same mocked repos.
    dataSource = {
      transaction: jest.fn(async (fn: (em: unknown) => Promise<unknown>) =>
        fn({
          getRepository: (entity: unknown) => {
            if (entity === ReferralEvent) return eventsRepo;
            if (entity === User) return usersRepo;
            return { update: jest.fn() };
          },
        }),
      ),
    };

    const mail = { send: jest.fn().mockResolvedValue(undefined) };
    const { MailService } = await import('../mail/mail.service');
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReferralsService,
        {
          provide: getRepositoryToken(ReferralEvent),
          useValue: eventsRepo,
        },
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: getRepositoryToken(ExamAnswer), useValue: answersRepo },
        { provide: getRepositoryToken(XpTransaction), useValue: xpTxRepo },
        { provide: GamificationService, useValue: gamification },
        { provide: NotificationsService, useValue: notifications },
        { provide: RedisService, useValue: redis },
        { provide: DataSource, useValue: dataSource },
        { provide: MailService, useValue: mail },
      ],
    }).compile();
    service = moduleRef.get(ReferralsService);
  });

  // ------------------------ issueSignupRewards ------------------------

  describe('issueSignupRewards', () => {
    it('no-ops when there is no pending event for the user', async () => {
      eventsRepo.findOne.mockResolvedValueOnce(null);
      await service.issueSignupRewards('user-1');
      expect(gamification.awardXp).not.toHaveBeenCalled();
    });

    it('awards XP to both sides and flips signupXpIssued=true', async () => {
      eventsRepo.findOne.mockResolvedValueOnce({
        id: 'evt-1',
        referrerId: 'ref',
        referredId: 'user-1',
      });
      gamification.awardXp.mockResolvedValue({ xpAmount: 50 });
      await service.issueSignupRewards('user-1');
      expect(gamification.awardXp).toHaveBeenCalledWith(
        'ref',
        'referral_referred',
        'evt-1',
      );
      expect(gamification.awardXp).toHaveBeenCalledWith(
        'user-1',
        'referral_new_user',
        'evt-1',
      );
      expect(eventsRepo.update).toHaveBeenCalledWith('evt-1', {
        signupXpIssued: true,
      });
    });
  });

  // ------------------------ checkQualification ------------------------

  describe('checkQualification', () => {
    it('returns false when there is no pending event for the user', async () => {
      eventsRepo.findOne.mockResolvedValueOnce(null);
      expect(await service.checkQualification('user-1')).toBe(false);
    });

    it('returns false when fewer than 10 answers exist', async () => {
      eventsRepo.findOne.mockResolvedValueOnce({
        id: 'evt-1',
        referrerId: 'ref',
        referredId: 'user-1',
      });
      answersRepo.manager.query.mockResolvedValueOnce([{ count: 9 }]);
      expect(await service.checkQualification('user-1')).toBe(false);
      expect(gamification.awardXp).not.toHaveBeenCalled();
    });

    it('promotes qualification, awards XP and pushes a notification at the threshold', async () => {
      eventsRepo.findOne.mockResolvedValueOnce({
        id: 'evt-1',
        referrerId: 'ref',
        referredId: 'user-1',
      });
      answersRepo.manager.query.mockResolvedValueOnce([{ count: 10 }]);
      gamification.awardXp.mockResolvedValueOnce({ xpAmount: 100 });
      usersRepo.findOne.mockResolvedValueOnce({ fullName: 'Kofi M.' });

      const out = await service.checkQualification('user-1');

      expect(out).toBe(true);
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(gamification.awardXp).toHaveBeenCalledWith(
        'ref',
        'referral_qualified',
        'evt-1',
      );
      expect(notifications.send).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'ref',
          title: expect.stringContaining('Referral qualified'),
          body: expect.stringContaining('Kofi'),
        }),
      );
    });
  });

  // ----------------------------- statsForUser -----------------------------

  it('statsForUser computes pending = referred - qualified', async () => {
    usersRepo.findOne.mockResolvedValueOnce({
      referralCode: 'PM-AB-CD',
      referralQualified: true,
    });
    eventsRepo.count
      .mockResolvedValueOnce(8) // referredCount
      .mockResolvedValueOnce(3); // qualifiedCount

    const out = await service.statsForUser('user-1');
    expect(out).toEqual({
      referralCode: 'PM-AB-CD',
      referredCount: 8,
      qualifiedCount: 3,
      pendingCount: 5,
      referralQualified: true,
    });
  });

  // ------------------------------ listEvents ------------------------------

  it('listEvents orders by newest-first and caps at 50', async () => {
    eventsRepo.find.mockResolvedValueOnce([]);
    await service.listEvents('user-1');
    expect(eventsRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { referrerId: 'user-1' },
        order: { createdAt: 'DESC' },
        take: 50,
      }),
    );
  });
});
