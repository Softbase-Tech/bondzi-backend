import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EntitlementsService } from './entitlements.service';
import { TierService } from './entities/tier-service.entity';
import { UserServiceUsage } from './entities/user-service-usage.entity';
import { User } from '../users/entities/user.entity';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import {
  AccountType,
  EntitlementService,
  ExamType,
} from '../../common/types/enums';

/**
 * EntitlementsService specs. The cap-counter atomicity is the
 * load-bearing invariant here: the UPSERT-and-RETURN pattern must
 * fire the raw query with the right arguments and interpret the
 * returned `used_count` correctly. The migration exercises the real
 * SQL — these tests exercise the flow control around it.
 */
describe('EntitlementsService', () => {
  let service: EntitlementsService;
  let tierServicesRepo: {
    findOne: jest.Mock;
    find: jest.Mock;
    save: jest.Mock;
  };
  let usageRepo: {
    query: jest.Mock;
    find: jest.Mock;
  };
  let usersRepo: { findOne: jest.Mock };
  let subscriptions: { entitlementFor: jest.Mock };

  beforeEach(async () => {
    tierServicesRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn(async (r: unknown) => r),
    };
    usageRepo = {
      query: jest.fn(),
      find: jest.fn(),
    };
    usersRepo = { findOne: jest.fn() };
    subscriptions = { entitlementFor: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        EntitlementsService,
        {
          provide: getRepositoryToken(TierService),
          useValue: tierServicesRepo,
        },
        {
          provide: getRepositoryToken(UserServiceUsage),
          useValue: usageRepo,
        },
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: SubscriptionsService, useValue: subscriptions },
      ],
    }).compile();
    service = moduleRef.get(EntitlementsService);
  });

  function seedUser(overrides: Partial<User> = {}): void {
    usersRepo.findOne.mockResolvedValueOnce({
      id: 'user-1',
      examType: ExamType.WASSCE,
      formLevel: 2,
      ...overrides,
    } as User);
  }

  function seedTier(tier: AccountType): void {
    subscriptions.entitlementFor.mockResolvedValueOnce({
      account: tier,
    } as never);
  }

  function seedPolicy(policy: Partial<TierService> | null): void {
    tierServicesRepo.findOne.mockResolvedValueOnce(policy as never);
  }

  function seedUpsertReturns(count: number): void {
    usageRepo.query.mockResolvedValueOnce([{ used_count: count }]);
  }

  describe('assertAndConsume', () => {
    it('throws NotFound when the user is missing', async () => {
      usersRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.assertAndConsume('ghost', EntitlementService.LEVEL_TESTS),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('fails closed (503) when the policy row is missing', async () => {
      seedUser();
      seedTier(AccountType.PLUS);
      seedPolicy(null);
      try {
        await service.assertAndConsume(
          'user-1',
          EntitlementService.LEVEL_TESTS,
        );
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
    });

    it('throws Forbidden when the policy is disabled', async () => {
      seedUser();
      seedTier(AccountType.FREE);
      seedPolicy({
        accountType: AccountType.FREE,
        service: EntitlementService.MOCK_EXAMS,
        enabled: false,
        dailyCap: 0,
        config: {},
      } as never);
      await expect(
        service.assertAndConsume('user-1', EntitlementService.MOCK_EXAMS),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws Forbidden when config.requiresFormLevel is set and user.formLevel is null (NOVDEC)', async () => {
      seedUser({ examType: ExamType.NOVDEC, formLevel: null });
      seedTier(AccountType.PLUS);
      seedPolicy({
        accountType: AccountType.PLUS,
        service: EntitlementService.LEVEL_TESTS,
        enabled: true,
        dailyCap: 80,
        config: { requiresFormLevel: true },
      } as never);
      await expect(
        service.assertAndConsume('user-1', EntitlementService.LEVEL_TESTS),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('increments and returns usedCount when under cap', async () => {
      seedUser();
      seedTier(AccountType.PLUS);
      seedPolicy({
        accountType: AccountType.PLUS,
        service: EntitlementService.AI_EXPLANATIONS,
        enabled: true,
        dailyCap: 20,
        config: {},
      } as never);
      seedUpsertReturns(4);
      const result = await service.assertAndConsume(
        'user-1',
        EntitlementService.AI_EXPLANATIONS,
      );
      expect(result.usedCount).toBe(4);
      expect(usageRepo.query).toHaveBeenCalledTimes(1);
      // The atomic-increment SQL is a specific shape — pin it so
      // a refactor can't accidentally drop the RETURNING clause.
      const firstArg = (
        usageRepo.query.mock.calls[0][0] as string
      ).toLowerCase();
      expect(firstArg).toContain('on conflict');
      expect(firstArg).toContain('returning');
    });

    it('throws 429 and decrements when the post-increment count exceeds the cap', async () => {
      seedUser();
      seedTier(AccountType.PLUS);
      seedPolicy({
        accountType: AccountType.PLUS,
        service: EntitlementService.AI_WEAKNESS_NARRATIVES,
        enabled: true,
        dailyCap: 1,
        config: {},
      } as never);
      // First call increments to 2 (over cap 1) → refuse.
      seedUpsertReturns(2);
      // Second call is the decrement UPDATE.
      usageRepo.query.mockResolvedValueOnce([]);
      await expect(
        service.assertAndConsume(
          'user-1',
          EntitlementService.AI_WEAKNESS_NARRATIVES,
        ),
      ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
      // Assert the second query was the decrement.
      const decSql = (usageRepo.query.mock.calls[1][0] as string).toLowerCase();
      expect(decSql).toContain('greatest');
      expect(decSql).toMatch(/-\s*1/);
    });

    it('treats subscription-resolve failures as FREE (safe default)', async () => {
      seedUser();
      subscriptions.entitlementFor.mockRejectedValueOnce(
        new Error('subs service down'),
      );
      // With tier=FREE, MOCK_EXAMS is disabled in the seed defaults.
      seedPolicy({
        accountType: AccountType.FREE,
        service: EntitlementService.MOCK_EXAMS,
        enabled: false,
        dailyCap: 0,
        config: {},
      } as never);
      await expect(
        service.assertAndConsume('user-1', EntitlementService.MOCK_EXAMS),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
