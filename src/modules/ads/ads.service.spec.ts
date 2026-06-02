import {
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdsService } from './ads.service';
import { AdConfig } from './entities/ad-config.entity';
import { RedisService } from '../../common/redis/redis.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { GamificationService } from '../gamification/gamification.service';

/**
 * AdsService gating logic. The two paths that matter:
 *   - getClientConfig: subscribed users must see adsEnabled=false AND all
 *     AdMob ids nulled so the SDK never initialises.
 *   - awardRewarded: must be gated by (1) not subscribed, (2) ads enabled,
 *     (3) under the daily cap. The daily counter is a per-user Redis key
 *     keyed by UTC date and never crosses midnight.
 */

describe('AdsService', () => {
  let service: AdsService;
  let configRepo: {
    createQueryBuilder: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let redis: { get: jest.Mock; incr: jest.Mock };
  let subscriptions: {
    hasActiveSubscription: jest.Mock;
    hasEntitlement: jest.Mock;
  };
  let gamification: { awardXpAmount: jest.Mock };
  let config: { get: jest.Mock };

  function stubConfig(over: Partial<Record<string, unknown>> = {}) {
    const qb = {
      orderBy: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({
        adsEnabled: true,
        adNetwork: 'admob',
        admobAppId: 'app',
        admobInterstitialId: 'int',
        admobRewardedId: 'rw',
        rewardedXpAmount: 20,
        frequencyCap: 3,
        triggerEvent: 'between_questions',
        ...over,
      }),
    };
    configRepo.createQueryBuilder.mockReturnValueOnce(qb);
  }

  beforeEach(async () => {
    configRepo = {
      createQueryBuilder: jest.fn(),
      create: jest.fn((o: unknown) => o),
      save: jest.fn(async (r: unknown) => r),
    };
    redis = { get: jest.fn(), incr: jest.fn() };
    subscriptions = {
      hasActiveSubscription: jest.fn(),
      hasEntitlement: jest.fn(),
    };
    gamification = { awardXpAmount: jest.fn() };
    // Default the launch-blocking gate ON for the existing happy-path tests
    // below. The "disabled by default" branch is exercised by its own test.
    config = {
      get: jest.fn((key: string) =>
        key === 'app.adsRewardedXpEnabled' ? true : undefined,
      ),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AdsService,
        { provide: getRepositoryToken(AdConfig), useValue: configRepo },
        { provide: RedisService, useValue: redis },
        { provide: SubscriptionsService, useValue: subscriptions },
        { provide: GamificationService, useValue: gamification },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    service = moduleRef.get(AdsService);
  });

  // -------------------------- getClientConfig --------------------------

  it('returns adsEnabled=false and null AdMob ids for subscribed users', async () => {
    stubConfig();
    subscriptions.hasEntitlement.mockResolvedValueOnce(true);
    const out = await service.getClientConfig('user-1', 'wassce' as never);
    expect(out.adsEnabled).toBe(false);
    expect(out.admobAppId).toBeNull();
    expect(out.admobRewardedId).toBeNull();
    expect(out.rewardedRemainingToday).toBe(0);
    // No Redis read for the subscribed branch — early-return.
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('returns the live config and a rewardedRemainingToday derived from Redis for free users', async () => {
    stubConfig({ frequencyCap: 3 });
    subscriptions.hasEntitlement.mockResolvedValueOnce(false);
    redis.get.mockResolvedValueOnce('1');
    const out = await service.getClientConfig('user-1', 'wassce' as never);
    expect(out.adsEnabled).toBe(true);
    expect(out.admobAppId).toBe('app');
    expect(out.rewardedRemainingToday).toBe(2); // 3 cap - 1 used
  });

  it('treats a non-numeric Redis value as 0 used', async () => {
    stubConfig({ frequencyCap: 3 });
    subscriptions.hasEntitlement.mockResolvedValueOnce(false);
    redis.get.mockResolvedValueOnce('abc');
    const out = await service.getClientConfig('user-1', 'wassce' as never);
    expect(out.rewardedRemainingToday).toBe(3);
  });

  // --------------------------- awardRewarded ---------------------------

  it('rejects with 503 when the launch-blocker env flag is off (default)', async () => {
    // Default-off: no SSV implementation yet, so the endpoint must NOT
    // mint XP on the client's word alone.
    config.get.mockReturnValueOnce(false);
    await expect(
      service.awardRewarded('user-1', 'wassce' as never),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(subscriptions.hasEntitlement).not.toHaveBeenCalled();
    expect(gamification.awardXpAmount).not.toHaveBeenCalled();
  });

  it('rejects rewarded XP claims from subscribed users with Forbidden', async () => {
    subscriptions.hasEntitlement.mockResolvedValueOnce(true);
    await expect(
      service.awardRewarded('user-1', 'wassce' as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(gamification.awardXpAmount).not.toHaveBeenCalled();
  });

  it('rejects with NotFound when ads are globally disabled', async () => {
    subscriptions.hasEntitlement.mockResolvedValueOnce(false);
    stubConfig({ adsEnabled: false });
    await expect(
      service.awardRewarded('user-1', 'wassce' as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects with Forbidden once the user crosses the daily cap', async () => {
    subscriptions.hasEntitlement.mockResolvedValueOnce(false);
    stubConfig({ frequencyCap: 2 });
    redis.incr.mockResolvedValueOnce(3); // used > cap
    await expect(
      service.awardRewarded('user-1', 'wassce' as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(gamification.awardXpAmount).not.toHaveBeenCalled();
  });

  it('awards via GamificationService and returns the remaining quota', async () => {
    subscriptions.hasEntitlement.mockResolvedValueOnce(false);
    stubConfig({ rewardedXpAmount: 25, frequencyCap: 5 });
    redis.incr.mockResolvedValueOnce(1);
    gamification.awardXpAmount.mockResolvedValueOnce({ xpAmount: 25 });
    const out = await service.awardRewarded('user-1', 'wassce' as never);
    expect(gamification.awardXpAmount).toHaveBeenCalledWith(
      'user-1',
      25,
      'rewarded_ad',
      null,
    );
    expect(out).toEqual({ xpAwarded: 25, rewardedRemainingToday: 4 });
  });

  // --------------------------- getAdminConfig ---------------------------

  it('auto-provisions a config row when none exists', async () => {
    configRepo.createQueryBuilder.mockReturnValueOnce({
      orderBy: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    });
    await service.getAdminConfig();
    expect(configRepo.create).toHaveBeenCalledWith({});
    expect(configRepo.save).toHaveBeenCalled();
  });
});
