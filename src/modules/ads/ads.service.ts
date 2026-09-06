import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdConfig } from './entities/ad-config.entity';
import { RedisService } from '../../common/redis/redis.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { GamificationService } from '../gamification/gamification.service';
import { UpdateAdConfigDto } from './dto/update-ad-config.dto';
import { AccountType, ExamType } from '../../common/types/enums';

/**
 * v2 Phase-2 ads. Free-tier students only: SubscriptionsService is consulted
 * on every student-facing call so subscribed users never see ad slots and
 * can't exploit the rewarded-XP path.
 *
 * Rewarded frequency is capped per-user per-UTC-day via a Redis counter
 * keyed by `ads:rewarded:{userId}:{YYYY-MM-DD}`.
 */
const WEB_ADS_CACHE_KEY = 'ads:web-config:v1';

@Injectable()
export class AdsService {
  private readonly logger = new Logger(AdsService.name);

  constructor(
    @InjectRepository(AdConfig)
    private readonly configRepo: Repository<AdConfig>,
    private readonly redis: RedisService,
    private readonly subscriptions: SubscriptionsService,
    private readonly gamification: GamificationService,
    private readonly config: ConfigService,
  ) {}

  /** Admin config. Single-row table — first row is the live config. */
  async getAdminConfig(): Promise<AdConfig> {
    let row = await this.configRepo
      .createQueryBuilder('c')
      .orderBy('c.updatedAt', 'DESC')
      .getOne();
    if (!row) {
      // Auto-provision in case the migration seed was skipped.
      row = this.configRepo.create({});
      await this.configRepo.save(row);
    }
    return row;
  }

  async updateAdminConfig(patch: UpdateAdConfigDto): Promise<AdConfig> {
    const row = await this.getAdminConfig();
    const { webAds, ...rest } = patch;
    Object.assign(row, rest);
    if (webAds !== undefined) {
      // Merge rather than replace so the admin UI can PATCH one
      // placement without carrying the whole map.
      const current = row.webAds ?? {};
      row.webAds = {
        ...current,
        ...(webAds.enabled !== undefined ? { enabled: webAds.enabled } : {}),
        ...(webAds.publisherId !== undefined
          ? { publisherId: webAds.publisherId }
          : {}),
        placements: {
          ...(current.placements ?? {}),
          ...(webAds.placements ?? {}),
        } as AdConfig['webAds']['placements'],
      };
    }
    const saved = await this.configRepo.save(row);
    // The public web config is cached; a config change must be visible
    // to the website within seconds, not a TTL.
    await this.redis.del(WEB_ADS_CACHE_KEY).catch(() => void 0);
    return saved;
  }

  /**
   * Public config for the WEBSITE's ad slots (blog first). No auth —
   * blog readers are anonymous — and nothing sensitive: publisher and
   * slot ids are visible in any ad-carrying page's source anyway.
   * Only enabled placements with a slot id are returned, so the
   * website renders nothing for half-configured rows.
   */
  async getWebConfig(): Promise<{
    enabled: boolean;
    publisherId: string | null;
    placements: Record<string, { slotId: string; afterBlock?: number }>;
  }> {
    const cached = await this.redis
      .getJson<{
        enabled: boolean;
        publisherId: string | null;
        placements: Record<string, { slotId: string; afterBlock?: number }>;
      }>(WEB_ADS_CACHE_KEY)
      .catch(() => null);
    if (cached) return cached;

    const row = await this.getAdminConfig();
    const cfg = row.webAds ?? {};
    const out: {
      enabled: boolean;
      publisherId: string | null;
      placements: Record<string, { slotId: string; afterBlock?: number }>;
    } = {
      enabled: cfg.enabled === true,
      publisherId: cfg.publisherId ?? null,
      placements: {},
    };
    if (out.enabled && out.publisherId) {
      for (const [key, p] of Object.entries(cfg.placements ?? {})) {
        if (!p?.enabled || !p.slotId) continue;
        out.placements[key] = {
          slotId: p.slotId,
          ...(p.afterBlock ? { afterBlock: p.afterBlock } : {}),
        };
      }
    }
    await this.redis.setJson(WEB_ADS_CACHE_KEY, out, 60).catch(() => void 0);
    return out;
  }

  /**
   * Public-facing config for the mobile app. Returns the minimum the client
   * needs to render AdMob slots + know what rewarded XP to advertise. Always
   * returns `adsEnabled=false` for subscribed users so the client never even
   * initialises the AdMob SDK for them.
   */
  async getClientConfig(
    userId: string,
    examType: ExamType | null | undefined,
  ): Promise<{
    adsEnabled: boolean;
    adNetwork: string;
    admobAppId: string | null;
    admobInterstitialId: string | null;
    admobRewardedId: string | null;
    rewardedXpAmount: number;
    frequencyCap: number;
    triggerEvent: string;
    rewardedRemainingToday: number;
  }> {
    const config = await this.getAdminConfig();
    // Ads-off is a Plus/Pro perk for the user's CURRENT level. A student
    // holding Plus on SHS still sees ads if they switch their profile to
    // NOVDEC (Free on NOVDEC) — otherwise Free NOVDEC content would be
    // ads-free for anyone who once paid for any other level.
    const subscribed = await this.subscriptions.hasEntitlement(
      userId,
      examType,
      AccountType.PLUS,
    );
    if (subscribed) {
      return {
        adsEnabled: false,
        adNetwork: config.adNetwork,
        admobAppId: null,
        admobInterstitialId: null,
        admobRewardedId: null,
        rewardedXpAmount: config.rewardedXpAmount,
        frequencyCap: config.frequencyCap,
        triggerEvent: config.triggerEvent,
        rewardedRemainingToday: 0,
      };
    }
    const used = await this.rewardedViewsToday(userId);
    return {
      adsEnabled: config.adsEnabled,
      adNetwork: config.adNetwork,
      admobAppId: config.admobAppId,
      admobInterstitialId: config.admobInterstitialId,
      admobRewardedId: config.admobRewardedId,
      rewardedXpAmount: config.rewardedXpAmount,
      frequencyCap: config.frequencyCap,
      triggerEvent: config.triggerEvent,
      rewardedRemainingToday: Math.max(0, config.frequencyCap - used),
    };
  }

  /**
   * Student watched a rewarded ad. Gate with subscription + frequency cap,
   * then award the configured XP via GamificationService.
   *
   * CRITICAL: this endpoint accepts the CLIENT's word that an ad was
   * watched. Without AdMob Server-Side Verification (SSV) — an HTTPS
   * callback from AdMob's servers carrying a signed payload that the
   * backend verifies against AdMob's published public keys — a curl
   * loop can mint XP up to the daily `frequencyCap` and redeem it for
   * Pro days. The endpoint is therefore gated behind the
   * `ADS_REWARDED_XP_ENABLED` env flag (defaults to false). Flip it on
   * ONLY after the AdMob SSV callback path is implemented.
   */
  async awardRewarded(
    userId: string,
    examType: ExamType | null | undefined,
  ): Promise<{
    xpAwarded: number;
    rewardedRemainingToday: number;
  }> {
    const enabled = this.config.get<boolean>('app.adsRewardedXpEnabled');
    if (!enabled) {
      this.logger.warn(
        `[ads] rewarded XP request from user=${userId} rejected — ADS_REWARDED_XP_ENABLED=false`,
      );
      throw new ServiceUnavailableException({
        code: 'REWARDED_XP_DISABLED',
        message:
          'Rewarded XP is temporarily unavailable while ad verification is being upgraded.',
      });
    }
    // Rewarded ads are a Free-only acquisition mechanism for THIS level —
    // a Plus/Pro holder on the user's current level can't loop through
    // rewarded videos to mint extra XP (their ad-free experience is the
    // payoff for their purchase).
    const subscribed = await this.subscriptions.hasEntitlement(
      userId,
      examType,
      AccountType.PLUS,
    );
    if (subscribed) {
      throw new ForbiddenException('Ads are disabled for subscribed users.');
    }
    const config = await this.getAdminConfig();
    if (!config.adsEnabled) {
      throw new NotFoundException('Ads are not currently enabled.');
    }

    const used = await this.redis.incr(
      this.rewardedKey(userId),
      this.ttlToMidnight(),
    );
    if (used > config.frequencyCap) {
      throw new ForbiddenException(
        `Daily rewarded-ad limit (${config.frequencyCap}) reached.`,
      );
    }

    // Spec §8.4: award `ad_config.rewarded_xp_amount` via GamificationService.
    // The amount lives on ad_config (not xp_rate_config) so admins can tune
    // ad reward without touching the earn-rate table.
    const award = await this.gamification.awardXpAmount(
      userId,
      config.rewardedXpAmount,
      'rewarded_ad',
      null,
    );
    return {
      xpAwarded: award.xpAmount,
      rewardedRemainingToday: Math.max(0, config.frequencyCap - used),
    };
  }

  private async rewardedViewsToday(userId: string): Promise<number> {
    const raw = await this.redis.get(this.rewardedKey(userId));
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  }

  private rewardedKey(userId: string): string {
    return `ads:rewarded:${userId}:${new Date().toISOString().slice(0, 10)}`;
  }

  /** Seconds until next UTC midnight — bounds the per-day counter. */
  private ttlToMidnight(): number {
    const now = new Date();
    const tomorrow = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    );
    return Math.max(
      60,
      Math.floor((tomorrow.getTime() - now.getTime()) / 1000),
    );
  }
}
