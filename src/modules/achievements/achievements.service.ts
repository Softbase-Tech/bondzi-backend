import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Achievement,
  AchievementMetricKey,
} from './entities/achievement.entity';
import { UserAchievement } from './entities/user-achievement.entity';
import { UsersService } from '../users/users.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationChannel } from '../../common/types/enums';
import {
  CreateAchievementDto,
  UpsertAchievementDto,
} from './dto/upsert-achievement.dto';

/**
 * View emitted to the mobile client on GET /users/me/achievements.
 * Merges catalogue + per-user progress + the live evaluated value so
 * the client renders the full strip without a follow-up call.
 */
export interface AchievementView {
  id: string;
  key: string;
  title: string;
  description: string | null;
  iconKey: string;
  gradientStart: string;
  gradientEnd: string;
  metricKey: AchievementMetricKey;
  thresholdValue: number;
  minAnswers: number | null;
  sortOrder: number;
  progressCurrent: number;
  progressTarget: number;
  unlocked: boolean;
  unlockedAt: string | null;
  /**
   * Short mobile-safe caption. `Unlocked` when done, otherwise a
   * progress hint like `22/50` or `20/20 for a rating`. The client
   * can render its own string, but shipping a canonical one from the
   * server means every surface (Home strip, admin dashboards, push
   * notifications) uses the same words.
   */
  progressLabel: string;
}

@Injectable()
export class AchievementsService {
  private readonly logger = new Logger(AchievementsService.name);

  constructor(
    @InjectRepository(Achievement)
    private readonly achievementsRepo: Repository<Achievement>,
    @InjectRepository(UserAchievement)
    private readonly userAchievementsRepo: Repository<UserAchievement>,
    private readonly usersService: UsersService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Evaluate every ACTIVE catalogue row against the user's current
   * stats, upsert per-user progress rows (stamping unlockedAt the
   * first time a threshold is crossed), and return the merged view.
   *
   * Cheap: one stats call + one catalogue read + one join on
   * user_achievements. Runs on every profile open — no cache. If we
   * see this in the top-N slowest endpoints later, we cache by
   * (userId, achievement.updatedAt) — but the profile is already
   * doing multiple RTTs so it's not the hot path today.
   */
  async listForUser(userId: string): Promise<AchievementView[]> {
    const [catalogue, progressRows, stats] = await Promise.all([
      this.achievementsRepo.find({
        where: { isActive: true },
        order: { sortOrder: 'ASC', createdAt: 'ASC' },
      }),
      this.userAchievementsRepo.find({ where: { userId } }),
      this.usersService.getStats(userId),
    ]);

    const progressByAchievement = new Map(
      progressRows.map((r) => [r.achievementId, r] as const),
    );

    // Normalise the two stat conventions the client + service use:
    // `stats.accuracy` is a 0–100 percent (may have one decimal); we
    // truncate for the threshold comparison. `streakBroken` masks
    // the persisted streakDays to 0 for the max-streak metric, same
    // guard the mobile client applies on the flame.
    const answersCount = stats.totalQuestionsAttempted;
    const accuracyPct = Math.floor(stats.accuracy);
    const currentStreak = stats.streakBroken ? 0 : stats.streakDays;
    const longestStreak = stats.longestStreak;
    const level = stats.level;

    const currentByMetric: Record<AchievementMetricKey, number> = {
      answers_count: answersCount,
      streak_max: Math.max(currentStreak, longestStreak),
      longest_streak: longestStreak,
      accuracy_pct: accuracyPct,
      level,
    };

    const now = new Date();
    const toUpsert: Array<{
      row: UserAchievement | null;
      achievement: Achievement;
      current: number;
      unlocked: boolean;
    }> = [];

    const views: AchievementView[] = catalogue.map((a) => {
      const current = currentByMetric[a.metricKey] ?? 0;
      const gate =
        a.minAnswers !== null && a.minAnswers !== undefined
          ? answersCount >= a.minAnswers
          : true;
      const unlocked = gate && current >= a.thresholdValue;
      const existing = progressByAchievement.get(a.id) ?? null;
      toUpsert.push({ row: existing, achievement: a, current, unlocked });

      const unlockedAt = unlocked
        ? (existing?.unlockedAt ?? now).toISOString()
        : null;
      return {
        id: a.id,
        key: a.key,
        title: a.title,
        description: a.description,
        iconKey: a.iconKey,
        gradientStart: a.gradientStart,
        gradientEnd: a.gradientEnd,
        metricKey: a.metricKey,
        thresholdValue: a.thresholdValue,
        minAnswers: a.minAnswers,
        sortOrder: a.sortOrder,
        progressCurrent: current,
        progressTarget: a.thresholdValue,
        unlocked,
        unlockedAt,
        progressLabel: buildProgressLabel(a, current, answersCount, unlocked),
      };
    });

    // Fire-and-forget: reconcile the per-user rows so future reads +
    // admin dashboards see fresh progress + first-unlock timestamps.
    // We swallow errors — a failed reconciliation shouldn't block the
    // response the student is waiting on.
    this.reconcileProgress(userId, toUpsert, now).catch((err) => {
      this.logger.warn(
        `reconcileProgress failed for user ${userId}: ${String(err)}`,
      );
    });

    return views;
  }

  private async reconcileProgress(
    userId: string,
    entries: Array<{
      row: UserAchievement | null;
      achievement: Achievement;
      current: number;
      unlocked: boolean;
    }>,
    now: Date,
  ): Promise<void> {
    // Only touch rows that actually changed — progress movement or a
    // freshly crossed threshold. Skipping no-ops keeps the upsert
    // volume small in the read path.
    const dirty = entries.filter((e) => {
      if (!e.row) return true; // never seen — record baseline
      if (e.unlocked && e.row.unlockedAt === null) return true;
      if (e.row.progressSnapshot !== e.current) return true;
      return false;
    });
    if (dirty.length === 0) return;

    // Freshly-crossed unlocks: either a brand-new row that already
    // qualifies, or an existing row whose unlockedAt was null and just
    // flipped to true. `!e.row` alone isn't enough — a first-time read
    // for someone already past the threshold is still a fresh unlock.
    const freshlyUnlocked = dirty.filter(
      (e) => e.unlocked && (e.row === null || e.row.unlockedAt === null),
    );

    await this.userAchievementsRepo.save(
      dirty.map((e) =>
        this.userAchievementsRepo.create({
          id: e.row?.id,
          userId,
          achievementId: e.achievement.id,
          unlockedAt: e.unlocked ? (e.row?.unlockedAt ?? now) : null,
          progressSnapshot: e.current,
        }),
      ),
    );

    // Notify per fresh unlock. Fire-and-forget parallel — one bad
    // send shouldn't block the others, and none should block the
    // reconcile save that's already durable.
    if (freshlyUnlocked.length > 0) {
      await Promise.allSettled(
        freshlyUnlocked.map((e) =>
          this.dispatchUnlockNotification(userId, e.achievement),
        ),
      );
    }
  }

  /**
   * Send both an in-app row and a push for a freshly-crossed
   * threshold. Both carry `achievementId` in the data payload so the
   * mobile client can deep-link to the detail sheet from either
   * surface. Failures are logged but never rethrown — the reconcile
   * write is what matters; the notification is best-effort.
   */
  private async dispatchUnlockNotification(
    userId: string,
    achievement: Achievement,
  ): Promise<void> {
    const title = 'Badge unlocked!';
    const body = `${achievement.title} — nice work.`;
    const data = { achievementId: achievement.id, kind: 'achievement' };
    for (const channel of [
      NotificationChannel.IN_APP,
      NotificationChannel.PUSH,
    ]) {
      try {
        await this.notifications.send({
          userId,
          channel,
          title,
          body,
          data,
        });
      } catch (err) {
        this.logger.warn(
          `achievement unlock notification (${channel}) failed for ` +
            `user=${userId} achievement=${achievement.key}: ${String(err)}`,
        );
      }
    }
  }

  // ─── Admin surface ──────────────────────────────────────────────
  async listAllForAdmin(): Promise<Achievement[]> {
    return this.achievementsRepo.find({
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
  }

  async create(dto: CreateAchievementDto): Promise<Achievement> {
    // Keys are UNIQUE at the DB level too — but returning a friendly
    // 409 is nicer than surfacing the raw driver error.
    const clash = await this.achievementsRepo.findOne({
      where: { key: dto.key },
    });
    if (clash) {
      throw new ConflictException(`Achievement key "${dto.key}" already used`);
    }
    if (
      dto.metricKey === 'accuracy_pct' &&
      (dto.thresholdValue < 1 || dto.thresholdValue > 100)
    ) {
      throw new BadRequestException(
        'thresholdValue for accuracy_pct must be between 1 and 100',
      );
    }
    const row = this.achievementsRepo.create({
      key: dto.key,
      title: dto.title,
      description: dto.description ?? null,
      metricKey: dto.metricKey,
      thresholdValue: dto.thresholdValue,
      minAnswers: dto.minAnswers ?? null,
      iconKey: dto.iconKey,
      gradientStart: dto.gradientStart,
      gradientEnd: dto.gradientEnd,
      sortOrder: dto.sortOrder ?? 0,
      isActive: dto.isActive ?? true,
    });
    return this.achievementsRepo.save(row);
  }

  async update(id: string, dto: UpsertAchievementDto): Promise<Achievement> {
    const row = await this.achievementsRepo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Achievement not found');
    // Reject a key change that would clash with another row.
    if (dto.key && dto.key !== row.key) {
      const clash = await this.achievementsRepo.findOne({
        where: { key: dto.key },
      });
      if (clash && clash.id !== id) {
        throw new ConflictException(
          `Achievement key "${dto.key}" already used`,
        );
      }
      row.key = dto.key;
    }
    if (dto.title !== undefined) row.title = dto.title;
    if (dto.description !== undefined) row.description = dto.description;
    if (dto.metricKey !== undefined) row.metricKey = dto.metricKey;
    if (dto.thresholdValue !== undefined)
      row.thresholdValue = dto.thresholdValue;
    if (dto.minAnswers !== undefined) row.minAnswers = dto.minAnswers;
    if (dto.iconKey !== undefined) row.iconKey = dto.iconKey;
    if (dto.gradientStart !== undefined) row.gradientStart = dto.gradientStart;
    if (dto.gradientEnd !== undefined) row.gradientEnd = dto.gradientEnd;
    if (dto.sortOrder !== undefined) row.sortOrder = dto.sortOrder;
    if (dto.isActive !== undefined) row.isActive = dto.isActive;

    if (
      row.metricKey === 'accuracy_pct' &&
      (row.thresholdValue < 1 || row.thresholdValue > 100)
    ) {
      throw new BadRequestException(
        'thresholdValue for accuracy_pct must be between 1 and 100',
      );
    }
    return this.achievementsRepo.save(row);
  }

  /**
   * Soft-retire only. Hard-delete would orphan per-user rows and
   * lose the unlockedAt timestamps that we may need for social /
   * receipt-style features later.
   */
  async retire(id: string): Promise<Achievement> {
    return this.update(id, { isActive: false });
  }
}

/**
 * Canonical progress label the client renders under each tile.
 * Server owns the string so admin dashboards + potential push
 * notifications agree on the wording.
 */
function buildProgressLabel(
  a: Achievement,
  current: number,
  answers: number,
  unlocked: boolean,
): string {
  if (unlocked) return 'Unlocked';
  // Accuracy achievements have a two-step progress story: first
  // clear the min-answers gate, THEN chase the percentage. Show the
  // more informative half.
  if (
    a.metricKey === 'accuracy_pct' &&
    a.minAnswers !== null &&
    a.minAnswers !== undefined &&
    answers < a.minAnswers
  ) {
    return `${answers}/${a.minAnswers} for a rating`;
  }
  if (a.metricKey === 'accuracy_pct') {
    return `${current}%`;
  }
  return `${current}/${a.thresholdValue}`;
}
