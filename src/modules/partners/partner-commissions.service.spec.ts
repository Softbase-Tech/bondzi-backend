import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  AccountType,
  ExamType,
  PartnerCommissionStatus,
  PartnerCommissionType,
  PartnerStatus,
  PaymentKind,
} from '../../common/types/enums';
import { Exam } from '../exams/entities/exam.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { SubscriptionPlanEntity } from '../subscriptions/plans/entities/subscription-plan.entity';
import { User } from '../users/entities/user.entity';
import { PartnerAttribution } from './entities/partner-attribution.entity';
import { PartnerCommission } from './entities/partner-commission.entity';
import { PartnerSignupCredit } from './entities/partner-signup-credit.entity';
import { Partner } from './entities/partner.entity';
import { PartnerCommissionsService } from './partner-commissions.service';
import { PartnerTermsService } from './partner-terms.service';

// -----------------------------------------------------------------------------
// Test fixtures
// -----------------------------------------------------------------------------

const TERMS = {
  id: 'terms-1',
  version: 1,
  plusWassce: '30.00',
  plusNovdec: '30.00',
  plusBece: '15.00',
  signupBatchSize: 10,
  signupBatchAmountGhs: '20.00',
  signupMinCompletedAnswers: 40,
  answersBonusThreshold: 100,
  answersBonusAmountGhs: '2.00',
  attributionWindowDays: 90,
  maxFraudFlagsBeforeBlock: 3,
  maxAppeals: 3,
};

/**
 * Fake pg unique-violation error. TypeORM's QueryFailedError puts the
 * driver error's `code` on both the top-level and under
 * `.driverError.code`; we mimic that shape.
 */
class UniqueViolationError extends Error {
  code = '23505';
  driverError = { code: '23505' };
}

// -----------------------------------------------------------------------------
// Suite
// -----------------------------------------------------------------------------

describe('PartnerCommissionsService', () => {
  let service: PartnerCommissionsService;
  let commissionsRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let attrsRepo: { findOne: jest.Mock };
  let creditsRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let partnersRepo: { findOne: jest.Mock };
  let subsRepo: {
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let plansRepo: { findOne: jest.Mock };
  let usersRepo: { findOne: jest.Mock };
  let examsRepo: { findOne: jest.Mock };
  let answersRepo: {
    createQueryBuilder: jest.Mock;
  };
  let terms: { getCurrent: jest.Mock; findById: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  // Repos used inside dataSource.transaction; assigned per-test.
  let txCommissionsRepo: {
    save: jest.Mock;
    create: jest.Mock;
  };
  let txCreditsRepo: {
    createQueryBuilder: jest.Mock;
  };

  const partnerActive = (patch: Partial<Partner> = {}) =>
    ({
      id: 'partner-1',
      userId: 'partner-user-1',
      status: PartnerStatus.ACTIVE,
      ...patch,
    }) as unknown as Partner;

  const attribution = (patch: Partial<PartnerAttribution> = {}) =>
    ({
      id: 'attr-1',
      userId: 'referred-1',
      partnerId: 'partner-1',
      partnerReferralCodeId: 'code-1',
      suspicionFlags: [],
      ...patch,
    }) as unknown as PartnerAttribution;

  const wassecePlan = {
    id: 'plan-1',
    account: AccountType.PLUS,
    level: ExamType.WASSCE,
    paymentKind: PaymentKind.ONE_TIME,
  };

  const subscription = (patch: Partial<Subscription> = {}) =>
    ({
      id: 'sub-1',
      userId: 'referred-1',
      planId: 'plan-1',
      startsAt: new Date('2026-07-01T00:00:00.000Z'),
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      ...patch,
    }) as unknown as Subscription;

  const referredUser = {
    id: 'referred-1',
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
  } as unknown as User;

  beforeEach(async () => {
    commissionsRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((o) => o),
      save: jest.fn(async (o) => ({ id: 'commission-1', ...o })),
    };
    attrsRepo = { findOne: jest.fn().mockResolvedValue(null) };
    creditsRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((o) => o),
      save: jest.fn(async (o) => ({ id: 'credit-1', ...o })),
    };
    partnersRepo = { findOne: jest.fn().mockResolvedValue(partnerActive()) };
    subsRepo = {
      findOne: jest.fn().mockResolvedValue(subscription()),
      createQueryBuilder: jest.fn(),
    };
    plansRepo = { findOne: jest.fn().mockResolvedValue(wassecePlan) };
    usersRepo = { findOne: jest.fn().mockResolvedValue(referredUser) };
    examsRepo = { findOne: jest.fn() };
    answersRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ c: '0' }),
      }),
    };
    terms = {
      getCurrent: jest.fn().mockResolvedValue(TERMS),
      findById: jest.fn().mockResolvedValue(TERMS),
    };

    // Per-transaction repos: pre-wired so tests that invoke
    // tryCloseBatch can override them individually via mock overrides.
    txCommissionsRepo = {
      save: jest.fn(async (o) => ({ id: 'batched-commission', ...o })),
      create: jest.fn((o) => o),
    };
    txCreditsRepo = {
      createQueryBuilder: jest.fn(),
    };

    dataSource = {
      transaction: jest
        .fn()
        .mockImplementation(
          async (
            fn: (em: {
              getRepository: (entity: unknown) => unknown;
            }) => Promise<unknown>,
          ) =>
            fn({
              getRepository: (entity: unknown) => {
                if (entity === PartnerCommission) return txCommissionsRepo;
                if (entity === PartnerSignupCredit) return txCreditsRepo;
                throw new Error(
                  `unexpected em.getRepository in test: ${(entity as { name?: string })?.name ?? String(entity)}`,
                );
              },
            }),
        ),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PartnerCommissionsService,
        {
          provide: getRepositoryToken(PartnerCommission),
          useValue: commissionsRepo,
        },
        {
          provide: getRepositoryToken(PartnerAttribution),
          useValue: attrsRepo,
        },
        {
          provide: getRepositoryToken(PartnerSignupCredit),
          useValue: creditsRepo,
        },
        { provide: getRepositoryToken(Partner), useValue: partnersRepo },
        { provide: getRepositoryToken(Subscription), useValue: subsRepo },
        {
          provide: getRepositoryToken(SubscriptionPlanEntity),
          useValue: plansRepo,
        },
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: getRepositoryToken(Exam), useValue: examsRepo },
        { provide: getRepositoryToken(ExamAnswer), useValue: answersRepo },
        { provide: PartnerTermsService, useValue: terms },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = moduleRef.get(PartnerCommissionsService);
  });

  // ==========================================================================
  // Stream A — Plus subscription
  // ==========================================================================

  describe('creditPlusSubscription', () => {
    it('credits an APPROVED plus_subscription commission for an active partner + attributed user + WASSCE Plus in-window', async () => {
      attrsRepo.findOne.mockResolvedValueOnce(attribution());
      const out = await service.creditPlusSubscription('sub-1');
      expect(out).not.toBeNull();
      const row = commissionsRepo.save.mock.calls[0][0];
      expect(row.type).toBe(PartnerCommissionType.PLUS_SUBSCRIPTION);
      expect(row.amountGhs).toBe(TERMS.plusWassce);
      expect(row.status).toBe(PartnerCommissionStatus.APPROVED);
      expect(row.dedupKey).toBe('sub-1');
      expect(row.subscriptionId).toBe('sub-1');
      expect(row.userId).toBe('referred-1');
      expect(row.termsVersionId).toBe(TERMS.id);
    });

    it('lands a FLAGGED commission when the attribution has any suspicion flags', async () => {
      attrsRepo.findOne.mockResolvedValueOnce(
        attribution({ suspicionFlags: ['same_device'] }),
      );
      await service.creditPlusSubscription('sub-1');
      const row = commissionsRepo.save.mock.calls[0][0];
      expect(row.status).toBe(PartnerCommissionStatus.FLAGGED);
      expect(row.flagReason).toBe('same_device');
      expect(row.flaggedAt).toBeInstanceOf(Date);
    });

    it('lands PENDING when the partner is SUSPENDED', async () => {
      attrsRepo.findOne.mockResolvedValueOnce(attribution());
      partnersRepo.findOne.mockResolvedValueOnce(
        partnerActive({ status: PartnerStatus.SUSPENDED }),
      );
      await service.creditPlusSubscription('sub-1');
      const row = commissionsRepo.save.mock.calls[0][0];
      expect(row.status).toBe(PartnerCommissionStatus.PENDING);
    });

    it('no-ops when the user has no attribution', async () => {
      attrsRepo.findOne.mockResolvedValueOnce(null);
      const out = await service.creditPlusSubscription('sub-1');
      expect(out).toBeNull();
      expect(commissionsRepo.save).not.toHaveBeenCalled();
    });

    it('no-ops when the partner is BANNED', async () => {
      attrsRepo.findOne.mockResolvedValueOnce(attribution());
      partnersRepo.findOne.mockResolvedValueOnce(
        partnerActive({ status: PartnerStatus.BANNED }),
      );
      const out = await service.creditPlusSubscription('sub-1');
      expect(out).toBeNull();
      expect(commissionsRepo.save).not.toHaveBeenCalled();
    });

    it('no-ops when the plan is Pro (recurring), not Plus', async () => {
      attrsRepo.findOne.mockResolvedValueOnce(attribution());
      plansRepo.findOne.mockResolvedValueOnce({
        ...wassecePlan,
        account: AccountType.PRO,
        paymentKind: PaymentKind.RECURRING,
      });
      const out = await service.creditPlusSubscription('sub-1');
      expect(out).toBeNull();
      expect(commissionsRepo.save).not.toHaveBeenCalled();
    });

    it('no-ops when the subscription activated OUTSIDE the attribution window', async () => {
      attrsRepo.findOne.mockResolvedValueOnce(attribution());
      // User registered 2026-01-01, subscription started 2026-06-01
      // → 150 days > 90-day window → no commission.
      usersRepo.findOne.mockResolvedValueOnce({
        id: 'referred-1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      subsRepo.findOne.mockResolvedValueOnce(
        subscription({
          startsAt: new Date('2026-06-01T00:00:00.000Z'),
          createdAt: new Date('2026-06-01T00:00:00.000Z'),
        }),
      );
      const out = await service.creditPlusSubscription('sub-1');
      expect(out).toBeNull();
      expect(commissionsRepo.save).not.toHaveBeenCalled();
    });

    it('is idempotent — a UNIQUE-violation on (partner, type, dedup_key) is absorbed as a no-op', async () => {
      attrsRepo.findOne.mockResolvedValueOnce(attribution());
      commissionsRepo.save.mockRejectedValueOnce(new UniqueViolationError());
      const out = await service.creditPlusSubscription('sub-1');
      expect(out).toBeNull();
    });

    it('uses the BECE amount for BECE plans and NOVDEC amount for NOVDEC', async () => {
      attrsRepo.findOne.mockResolvedValueOnce(attribution());
      plansRepo.findOne.mockResolvedValueOnce({
        ...wassecePlan,
        level: ExamType.BECE,
      });
      await service.creditPlusSubscription('sub-1');
      expect(commissionsRepo.save.mock.calls[0][0].amountGhs).toBe(
        TERMS.plusBece,
      );

      commissionsRepo.save.mockClear();
      attrsRepo.findOne.mockResolvedValueOnce(attribution());
      plansRepo.findOne.mockResolvedValueOnce({
        ...wassecePlan,
        level: ExamType.NOVDEC,
      });
      await service.creditPlusSubscription('sub-1');
      expect(commissionsRepo.save.mock.calls[0][0].amountGhs).toBe(
        TERMS.plusNovdec,
      );
    });
  });

  // ==========================================================================
  // Stream B — Signup batch
  // ==========================================================================

  describe('tickSignupProgress', () => {
    it('no-ops for an unattributed user', async () => {
      attrsRepo.findOne.mockResolvedValueOnce(null);
      await service.tickSignupProgress('u1');
      expect(creditsRepo.save).not.toHaveBeenCalled();
    });

    it('no-ops when the user has fewer answers than the threshold', async () => {
      attrsRepo.findOne.mockResolvedValueOnce(attribution());
      answersRepo.createQueryBuilder.mockReturnValueOnce({
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ c: '10' }),
      });
      await service.tickSignupProgress('u1');
      expect(creditsRepo.save).not.toHaveBeenCalled();
    });

    it('inserts a signup credit when the user crosses the threshold and no prior credit exists', async () => {
      attrsRepo.findOne.mockResolvedValueOnce(attribution());
      answersRepo.createQueryBuilder.mockReturnValueOnce({
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ c: '45' }),
      });
      // tryCloseBatch: 5 rows locked → below batch size → no commission.
      txCreditsRepo.createQueryBuilder.mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        setOnLocked: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          { id: 'c1', userId: 'u1' },
          { id: 'c2', userId: 'u2' },
        ]),
      });

      await service.tickSignupProgress('referred-1');
      expect(creditsRepo.save).toHaveBeenCalledTimes(1);
      expect(txCommissionsRepo.save).not.toHaveBeenCalled();
    });

    it('closes a batch when 10 unbatched credits are queued', async () => {
      attrsRepo.findOne.mockResolvedValueOnce(attribution());
      answersRepo.createQueryBuilder.mockReturnValueOnce({
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ c: '45' }),
      });
      const rows = Array.from({ length: 10 }, (_, i) => ({
        id: `c${i}`,
        userId: `u${i}`,
      }));
      const updateExec = jest.fn().mockResolvedValue({ affected: 10 });
      txCreditsRepo.createQueryBuilder.mockImplementation(() => {
        // First call: select FOR UPDATE. Second call: UPDATE ... SET
        // batched_commission_id = X.
        return {
          setLock: jest.fn().mockReturnThis(),
          setOnLocked: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue(rows),
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          whereInIds: jest.fn().mockReturnThis(),
          execute: updateExec,
        };
      });

      await service.tickSignupProgress('referred-1');
      // One commission written with the batch of 10 user ids.
      expect(txCommissionsRepo.save).toHaveBeenCalledTimes(1);
      const batched = txCommissionsRepo.save.mock.calls[0][0];
      expect(batched.type).toBe(PartnerCommissionType.SIGNUP_BATCH);
      expect(batched.amountGhs).toBe(TERMS.signupBatchAmountGhs);
      expect(batched.status).toBe(PartnerCommissionStatus.APPROVED);
      // batch_user_ids sorted → dedup_key comma-joined identical.
      expect(batched.batchUserIds).toHaveLength(10);
      expect(batched.dedupKey).toContain(',');
      // Credits get stamped with the batch id.
      expect(updateExec).toHaveBeenCalled();
    });

    it('no-ops when a credit already exists for this (partner, user) but still nudges tryCloseBatch', async () => {
      attrsRepo.findOne.mockResolvedValueOnce(attribution());
      creditsRepo.findOne.mockResolvedValueOnce({
        id: 'existing-credit',
        partnerId: 'partner-1',
        userId: 'referred-1',
      });
      txCreditsRepo.createQueryBuilder.mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        setOnLocked: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      });

      await service.tickSignupProgress('referred-1');
      expect(creditsRepo.save).not.toHaveBeenCalled();
      // tryCloseBatch was still called (transaction ran).
      expect(dataSource.transaction).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Stream C — Answers bonus
  // ==========================================================================

  describe('tickAnswersBonus', () => {
    const activePlusSub = () => ({ id: 'live-plus-sub' });

    beforeEach(() => {
      // Default: user HAS active paid Plus.
      subsRepo.createQueryBuilder.mockReturnValue({
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(activePlusSub()),
      });
    });

    it('no-ops for an unattributed user', async () => {
      attrsRepo.findOne.mockResolvedValueOnce(null);
      await service.tickAnswersBonus('u1');
      expect(commissionsRepo.save).not.toHaveBeenCalled();
    });

    it('no-ops for a Free user (no active paid Plus)', async () => {
      attrsRepo.findOne.mockResolvedValueOnce(attribution());
      subsRepo.createQueryBuilder.mockReturnValueOnce({
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      });
      await service.tickAnswersBonus('u1');
      expect(commissionsRepo.save).not.toHaveBeenCalled();
    });

    it('no-ops when the user has fewer answers than the answers threshold', async () => {
      attrsRepo.findOne.mockResolvedValueOnce(attribution());
      answersRepo.createQueryBuilder.mockReturnValueOnce({
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ c: '50' }),
      });
      await service.tickAnswersBonus('u1');
      expect(commissionsRepo.save).not.toHaveBeenCalled();
    });

    it('writes an APPROVED answers_bonus when a paid-Plus user crosses the threshold', async () => {
      attrsRepo.findOne.mockResolvedValueOnce(attribution());
      answersRepo.createQueryBuilder.mockReturnValueOnce({
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ c: '120' }),
      });
      await service.tickAnswersBonus('referred-1');
      expect(commissionsRepo.save).toHaveBeenCalledTimes(1);
      const row = commissionsRepo.save.mock.calls[0][0];
      expect(row.type).toBe(PartnerCommissionType.ANSWERS_BONUS);
      expect(row.amountGhs).toBe(TERMS.answersBonusAmountGhs);
      expect(row.status).toBe(PartnerCommissionStatus.APPROVED);
      // dedup_key encodes user + threshold so an admin bumping the
      // threshold later triggers a fresh bonus.
      expect(row.dedupKey).toBe(`referred-1:${TERMS.answersBonusThreshold}`);
    });

    it('is idempotent — dedup on user + threshold prevents double-bonuses', async () => {
      attrsRepo.findOne.mockResolvedValueOnce(attribution());
      answersRepo.createQueryBuilder.mockReturnValueOnce({
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ c: '120' }),
      });
      commissionsRepo.save.mockRejectedValueOnce(new UniqueViolationError());
      // Should NOT throw; a repeat call returns cleanly.
      await expect(
        service.tickAnswersBonus('referred-1'),
      ).resolves.toBeUndefined();
    });
  });

  // ==========================================================================
  // Clawback — Plus refund reversal
  // ==========================================================================

  describe('clawback', () => {
    it('no-ops when there is no plus_subscription commission for that subscription', async () => {
      commissionsRepo.findOne.mockResolvedValueOnce(null);
      const out = await service.clawback('sub-1', 'refund');
      expect(out).toBeNull();
      expect(commissionsRepo.save).not.toHaveBeenCalled();
    });

    it('flips PENDING → CLAWED_BACK without writing an offset row', async () => {
      const original = {
        id: 'commission-1',
        subscriptionId: 'sub-1',
        type: PartnerCommissionType.PLUS_SUBSCRIPTION,
        status: PartnerCommissionStatus.PENDING,
        amountGhs: '30.00',
        termsVersionId: TERMS.id,
        eligibilityMeta: {},
      };
      commissionsRepo.findOne.mockResolvedValueOnce(original);
      await service.clawback('sub-1', 'refund');
      // First save = update to CLAWED_BACK; no second save (no offset row).
      expect(commissionsRepo.save).toHaveBeenCalledTimes(1);
      expect(commissionsRepo.save.mock.calls[0][0].status).toBe(
        PartnerCommissionStatus.CLAWED_BACK,
      );
    });

    it('flips APPROVED → CLAWED_BACK without offset (partner never paid)', async () => {
      commissionsRepo.findOne.mockResolvedValueOnce({
        id: 'commission-1',
        subscriptionId: 'sub-1',
        type: PartnerCommissionType.PLUS_SUBSCRIPTION,
        status: PartnerCommissionStatus.APPROVED,
        amountGhs: '30.00',
        termsVersionId: TERMS.id,
        eligibilityMeta: {},
      });
      await service.clawback('sub-1', 'refund');
      expect(commissionsRepo.save).toHaveBeenCalledTimes(1);
      expect(commissionsRepo.save.mock.calls[0][0].status).toBe(
        PartnerCommissionStatus.CLAWED_BACK,
      );
    });

    it('writes a NEGATIVE offset commission when the original was already PAID', async () => {
      commissionsRepo.findOne.mockResolvedValueOnce({
        id: 'commission-1',
        subscriptionId: 'sub-1',
        partnerId: 'partner-1',
        userId: 'referred-1',
        type: PartnerCommissionType.PLUS_SUBSCRIPTION,
        status: PartnerCommissionStatus.PAID,
        amountGhs: '30.00',
        termsVersionId: TERMS.id,
        eligibilityMeta: {},
      });
      const out = await service.clawback('sub-1', 'refund');
      expect(out).not.toBeNull();
      // Two saves: (1) original → CLAWED_BACK, (2) negative offset row.
      expect(commissionsRepo.save).toHaveBeenCalledTimes(2);
      const offset = commissionsRepo.save.mock.calls[1][0];
      expect(offset.type).toBe(
        PartnerCommissionType.PLUS_SUBSCRIPTION_CLAWBACK,
      );
      expect(offset.amountGhs).toBe('-30.00');
      expect(offset.status).toBe(PartnerCommissionStatus.APPROVED);
      expect(offset.dedupKey).toBe('sub-1');
      expect(offset.eligibilityMeta?.offsetOfCommissionId).toBe('commission-1');
    });

    it('is idempotent — a second clawback call on an already-CLAWED_BACK commission is a no-op', async () => {
      commissionsRepo.findOne.mockResolvedValueOnce({
        id: 'commission-1',
        subscriptionId: 'sub-1',
        type: PartnerCommissionType.PLUS_SUBSCRIPTION,
        status: PartnerCommissionStatus.CLAWED_BACK,
        amountGhs: '30.00',
        termsVersionId: TERMS.id,
        eligibilityMeta: {},
      });
      const out = await service.clawback('sub-1', 'refund');
      expect(out).toBeNull();
      expect(commissionsRepo.save).not.toHaveBeenCalled();
    });
  });
});
