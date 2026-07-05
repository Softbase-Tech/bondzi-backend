import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TierService } from './entities/tier-service.entity';
import { UserServiceUsage } from './entities/user-service-usage.entity';
import { User } from '../users/entities/user.entity';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import {
  AccountType,
  EntitlementService,
  ExamType,
} from '../../common/types/enums';
import { accraDateIso } from '../../common/utils/timezone.util';

export interface EntitlementCheckResult {
  policy: TierService;
  /** After the increment. `undefined` when the policy is disabled. */
  usedCount?: number;
}

/**
 * Reads the tier × service matrix, resolves the caller's tier for
 * their current level, enforces the enabled/cap policy, and (on
 * success) atomically increments the day counter.
 *
 * "Atomic" matters: without it, two concurrent requests at the cap
 * boundary both read `used=N-1 < cap=N`, both proceed, and the effective
 * cap becomes N+1. We upsert with `ON CONFLICT ... DO UPDATE SET
 * used_count = user_service_usage.used_count + 1 RETURNING used_count`
 * so the second request sees the incremented value in the same
 * round-trip and can reject if it exceeded the cap.
 */
@Injectable()
export class EntitlementsService {
  private readonly logger = new Logger(EntitlementsService.name);

  constructor(
    @InjectRepository(TierService)
    private readonly tierServicesRepo: Repository<TierService>,
    @InjectRepository(UserServiceUsage)
    private readonly usageRepo: Repository<UserServiceUsage>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  /**
   * Guard entry point. Resolves the caller's tier (via their
   * examType-scoped entitlement), reads the policy, applies
   * config-driven gates (e.g. requiresFormLevel), enforces the cap
   * atomically, and returns the fresh usage snapshot.
   *
   * Throws:
   *   • 404 — policy row missing (this is an app-side bug: means the
   *     enum has a service key without a seed row).
   *   • 403 — service disabled for this tier, or a config gate fired
   *     (e.g. NOVDEC hitting `requiresFormLevel`).
   *   • 429 — daily cap reached.
   */
  async assertAndConsume(
    userId: string,
    service: EntitlementService,
  ): Promise<EntitlementCheckResult> {
    const user = await this.usersRepo.findOne({
      where: { id: userId },
      select: ['id', 'examType', 'formLevel'],
    });
    if (!user) throw new NotFoundException('User not found');

    const accountType = await this.resolveTier(user.id, user.examType);
    const policy = await this.tierServicesRepo.findOne({
      where: { accountType, service },
    });
    if (!policy) {
      // Missing seed row = code/config bug, not a user-facing 4xx.
      // Fail closed so a mistakenly-decorated endpoint doesn't leak.
      this.logger.error(
        `[entitlements] no policy for tier=${accountType} service=${service}`,
      );
      throw new HttpException(
        'Feature not configured for your tier.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (!policy.enabled) {
      throw new ForbiddenException(
        `This feature isn't available on your current tier.`,
      );
    }
    // Config-driven gates. requiresFormLevel refuses NOVDEC students
    // (formLevel=null) without hardcoding an exam-type list — if the
    // product ever adds a second no-form-level level (SHS Remedial
    // variants, etc.), the same flag catches them.
    if (policy.config?.requiresFormLevel === true && user.formLevel == null) {
      throw new ForbiddenException(
        'This feature requires a form level, which your current exam type does not have.',
      );
    }

    // Atomic upsert + increment. Returns the NEW used_count so we can
    // compare against the cap in the same round-trip.
    const today = accraDateIso();
    const rows: Array<{ used_count: number }> = await this.usageRepo.query(
      `insert into "user_service_usage" ("user_id", "service", "day", "used_count", "updated_at")
         values ($1, $2::entitlement_service_enum, $3::date, 1, now())
         on conflict ("user_id", "service", "day") do update
           set "used_count" = "user_service_usage"."used_count" + 1,
               "updated_at" = now()
         returning "used_count";`,
      [userId, service, today],
    );
    const usedCount = rows[0]?.used_count ?? 1;

    // Enforce cap AFTER the increment so the counter reflects the
    // attempt even if we're going to refuse. If we hit the cap on
    // this call, decrement so a legitimate future call in the same
    // day isn't blocked by our own bookkeeping.
    if (policy.dailyCap != null && usedCount > policy.dailyCap) {
      await this.usageRepo.query(
        `update "user_service_usage"
            set "used_count" = greatest("used_count" - 1, 0),
                "updated_at" = now()
          where "user_id" = $1 and "service" = $2::entitlement_service_enum and "day" = $3::date;`,
        [userId, service, today],
      );
      throw new HttpException(
        `You've hit your daily limit for this feature. Upgrade or try again tomorrow.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return { policy, usedCount };
  }

  /**
   * Resolves the tier a user gets for the given exam level. Falls back
   * to FREE on any resolution failure — safe default (block paid
   * services) rather than leak.
   */
  private async resolveTier(
    userId: string,
    level: ExamType | null | undefined,
  ): Promise<AccountType> {
    if (!level) return AccountType.FREE;
    try {
      const ent = await this.subscriptions.entitlementFor(userId, level);
      return ent.account;
    } catch (err) {
      this.logger.warn(
        `[entitlements] tier resolve failed user=${userId} level=${String(level)} err=${(err as Error).message}`,
      );
      return AccountType.FREE;
    }
  }

  // ------------------------- Admin surface -------------------------

  /** Full matrix — rows sorted for stable admin table rendering. */
  listMatrix(): Promise<TierService[]> {
    return this.tierServicesRepo.find({
      order: { accountType: 'ASC', service: 'ASC' },
    });
  }

  /** Update one cell of the matrix. Admin action. */
  async updatePolicy(
    adminId: string,
    accountType: AccountType,
    service: EntitlementService,
    patch: {
      enabled?: boolean;
      dailyCap?: number | null;
      config?: Record<string, unknown>;
    },
  ): Promise<TierService> {
    const row = await this.tierServicesRepo.findOne({
      where: { accountType, service },
    });
    if (!row) {
      throw new NotFoundException(
        `Policy not found for tier=${accountType} service=${service}`,
      );
    }
    if (patch.enabled !== undefined) row.enabled = patch.enabled;
    if (patch.dailyCap !== undefined) row.dailyCap = patch.dailyCap;
    if (patch.config !== undefined) row.config = patch.config;
    row.updatedBy = adminId;
    await this.tierServicesRepo.save(row);
    this.logger.log(
      `[entitlements] admin=${adminId} updated ${accountType}/${service} enabled=${row.enabled} cap=${row.dailyCap ?? '∞'}`,
    );
    return row;
  }

  /**
   * Today's usage for one user across every service. Powers the
   * admin "why did this student get rate-limited?" support screen.
   */
  usageForUserToday(userId: string): Promise<UserServiceUsage[]> {
    return this.usageRepo.find({
      where: { userId, day: accraDateIso() },
      order: { service: 'ASC' },
    });
  }
}
