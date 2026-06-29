import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { hashPassword, verifyPassword } from '../../common/utils/password.util';
import { User } from './entities/user.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { UserSubjectProgress } from '../progress/entities/user-subject-progress.entity';
import { Exam } from '../exams/entities/exam.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { UserSubject } from './entities/user-subject.entity';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateEmailPreferencesDto } from './dto/update-email-preferences.dto';
import { ChangePasswordDto } from '../auth/dto/change-password.dto';
import {
  canonicalUsername,
  daysUntilUsernameCooldownEnds,
  validateUsernameFormat,
} from './username.rules';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    @InjectRepository(Subscription)
    private readonly subsRepo: Repository<Subscription>,
    @InjectRepository(UserSubjectProgress)
    private readonly progressRepo: Repository<UserSubjectProgress>,
    @InjectRepository(Exam) private readonly examsRepo: Repository<Exam>,
    @InjectRepository(ExamAnswer)
    private readonly answersRepo: Repository<ExamAnswer>,
    @InjectRepository(Subject)
    private readonly subjectsRepo: Repository<Subject>,
    @InjectRepository(UserSubject)
    private readonly userSubjectsRepo: Repository<UserSubject>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Returns the subject IDs the user has explicitly selected.
   *
   * Soft-filter contract (see `1890-UserSubjects` migration): an empty
   * array means "no preference, show everything" — the mobile home tab
   * falls back to rendering all subjects when the list is empty. The
   * `addSelectedFlags` helper below applies that contract when joining
   * the user's selection to the public catalogue.
   */
  async getSelectedSubjectIds(userId: string): Promise<string[]> {
    const rows = await this.userSubjectsRepo.find({
      where: { userId },
      select: ['subjectId'],
    });
    return rows.map((r) => r.subjectId);
  }

  /**
   * Wholesale-replaces a user's subject selection. Atomic — either every
   * row in the new selection lands and the old ones are gone, or the
   * transaction rolls back and the prior selection is intact.
   *
   * Validation:
   *   - Caller-supplied IDs must all reference active subjects.
   *   - Each subject's `exam_type` must match the user's `exam_type`
   *     (no cross-level smuggling — a WASSCE student selecting a BECE
   *     subject would just see empty content downstream and confuse
   *     themselves; reject up-front).
   */
  async setSelectedSubjects(
    userId: string,
    subjectIds: string[],
  ): Promise<{ subjectIds: string[] }> {
    const user = await this.usersRepo.findOne({
      where: { id: userId },
      select: ['id', 'examType'],
    });
    if (!user) throw new NotFoundException('User not found');

    // Empty selection is a legitimate state — the user is opting back
    // into "no preference, show me everything". Short-circuit the
    // validation walk.
    const uniqueIds = Array.from(new Set(subjectIds));

    if (uniqueIds.length > 0) {
      const subjects = await this.subjectsRepo.find({
        where: { id: In(uniqueIds), isActive: true },
        select: ['id', 'examType'],
      });
      if (subjects.length !== uniqueIds.length) {
        throw new BadRequestException(
          'One or more subjects do not exist or are inactive.',
        );
      }
      const mismatched = subjects.filter((s) => s.examType !== user.examType);
      if (mismatched.length > 0) {
        throw new BadRequestException(
          'All selected subjects must match your current exam type.',
        );
      }
    }

    await this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(UserSubject);
      await repo.delete({ userId });
      if (uniqueIds.length > 0) {
        await repo.insert(
          uniqueIds.map((subjectId) => ({ userId, subjectId })),
        );
      }
    });
    return { subjectIds: uniqueIds };
  }

  async getMe(userId: string) {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    const subscription = await this.subsRepo.findOne({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    const progress = await this.progressRepo.find({
      where: { userId },
      relations: ['subject'],
    });
    return { user, subscription, progress };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<User> {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    Object.assign(user, dto);
    await this.usersRepo.save(user);
    return user;
  }

  async updateEmailPreferences(
    userId: string,
    dto: UpdateEmailPreferencesDto,
  ): Promise<{
    weeklyDigest: boolean;
    streakNudges: boolean;
    levelUp: boolean;
    marketing: boolean;
  }> {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (dto.weeklyDigest !== undefined) {
      user.emailWeeklyDigestEnabled = dto.weeklyDigest;
    }
    if (dto.streakNudges !== undefined) {
      user.emailStreakNudgesEnabled = dto.streakNudges;
    }
    if (dto.levelUp !== undefined) {
      user.emailLevelUpEnabled = dto.levelUp;
    }
    if (dto.marketing !== undefined) {
      user.emailMarketingEnabled = dto.marketing;
    }
    await this.usersRepo.save(user);
    return {
      weeklyDigest: user.emailWeeklyDigestEnabled,
      streakNudges: user.emailStreakNudgesEnabled,
      levelUp: user.emailLevelUpEnabled,
      marketing: user.emailMarketingEnabled,
    };
  }

  async changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
    const user = await this.usersRepo
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('u.id = :id', { id: userId })
      .getOne();
    if (!user || !user.passwordHash)
      throw new UnauthorizedException('Password change not allowed');

    const ok = await verifyPassword(user.passwordHash, dto.currentPassword);
    if (!ok) throw new UnauthorizedException('Current password is incorrect');

    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('New password must differ from current');
    }
    user.passwordHash = await hashPassword(dto.newPassword);
    await this.usersRepo.save(user);
  }

  async softDelete(userId: string): Promise<void> {
    await this.usersRepo.softDelete({ id: userId });
  }

  /**
   * Returns whether a username is currently claimable. Cheap public
   * check that powers the mobile registration / profile-edit
   * "available ✓ / taken ✗" hint as the user types.
   *
   * Three outcomes:
   *   - format invalid → { available: false, reason: 'invalid_chars' | ... }
   *   - format valid + collides (case-insensitive) → { available: false, reason: 'taken' }
   *   - format valid + free → { available: true }
   *
   * `currentUserId` lets the profile-edit flow check their CURRENT
   * username and still see `available: true` — otherwise the field
   * would always read "taken" when re-typing what they already own.
   */
  async checkUsernameAvailability(
    input: string,
    currentUserId?: string,
  ): Promise<{
    available: boolean;
    reason?: 'too_short' | 'too_long' | 'invalid_chars' | 'reserved' | 'taken';
    message?: string;
  }> {
    const fmt = validateUsernameFormat(input);
    if (!fmt.ok) {
      return { available: false, reason: fmt.reason, message: fmt.message };
    }
    const canonical = canonicalUsername(input);
    const owner = await this.usersRepo
      .createQueryBuilder('u')
      .select(['u.id'])
      .where('lower(u.username) = :canonical', { canonical })
      .getOne();
    if (owner && owner.id !== currentUserId) {
      return {
        available: false,
        reason: 'taken',
        message: 'This username is already taken.',
      };
    }
    return { available: true };
  }

  /**
   * Self-service username change. Same path is used for the first-time
   * back-fill (old accounts whose `username` is still NULL) and for
   * subsequent rename. The 90-day cooldown applies to the SECOND and
   * later change only — the first save sets the timer running.
   *
   * Race protection: relies on the partial unique index on
   * `lower(username)` (migration 1940). Two clients claiming the same
   * handle at the same millisecond → one save succeeds, the other hits
   * a Postgres UNIQUE violation that we translate into a 400 with
   * `reason: 'taken'`.
   */
  async updateUsername(
    userId: string,
    rawUsername: string,
  ): Promise<{ username: string; usernameChangedAt: Date }> {
    const fmt = validateUsernameFormat(rawUsername);
    if (!fmt.ok) {
      throw new BadRequestException(fmt.message ?? 'Invalid username.');
    }
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const now = new Date();

    // 90-day cooldown: applies only when the user is CHANGING (not back-filling).
    if (user.username !== null) {
      const daysLeft = daysUntilUsernameCooldownEnds(
        user.usernameChangedAt,
        now,
      );
      if (daysLeft > 0) {
        throw new BadRequestException(
          `You can change your username again in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`,
        );
      }
    }

    const canonical = canonicalUsername(rawUsername);
    const trimmed = rawUsername.trim();

    // If they're "changing" to the same handle (just a case-tweak,
    // e.g. ekowmensah → EkowMensah), allow it WITHOUT consuming the
    // cooldown — it's effectively a display preference, not a new
    // identity. The unique-index check below would otherwise treat
    // their own row as a collision.
    if (user.username && canonicalUsername(user.username) === canonical) {
      if (user.username === trimmed) {
        // No-op: same string verbatim. Return current state.
        return {
          username: user.username,
          usernameChangedAt: user.usernameChangedAt ?? now,
        };
      }
      user.username = trimmed;
      await this.usersRepo.save(user);
      return {
        username: user.username,
        usernameChangedAt: user.usernameChangedAt ?? now,
      };
    }

    // Uniqueness pre-check (cheaper failure path than the DB error).
    const collision = await this.usersRepo
      .createQueryBuilder('u')
      .select(['u.id'])
      .where('lower(u.username) = :canonical', { canonical })
      .getOne();
    if (collision) {
      throw new BadRequestException('This username is already taken.');
    }

    user.username = trimmed;
    user.usernameChangedAt = now;
    try {
      await this.usersRepo.save(user);
    } catch (err: unknown) {
      const message = (err as { message?: string })?.message ?? '';
      if (message.includes('users_username_lower_unique')) {
        throw new BadRequestException('This username is already taken.');
      }
      throw err;
    }
    return { username: user.username, usernameChangedAt: now };
  }

  async getProgress(userId: string): Promise<UserSubjectProgress[]> {
    return this.progressRepo.find({
      where: { userId },
      relations: ['subject'],
    });
  }

  /**
   * Single endpoint that drives the home-tab gamification card (mobile
   * `UserStatsSchema`). Daily goal progress, weekly volume, and study time
   * are all derived from exam_answers — keep the compute here rather than
   * tracking separate counters that can drift.
   *
   * XP: 10 per correct answer for now. When achievements / streak bonuses
   * land, move to a tracked column on users.
   */
  async getStats(userId: string) {
    const now = new Date();
    const startOfDay = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );
    // Week starts Monday (§4.3 spec) — shift sunday(0) → mon-based.
    const daySinceMon = (now.getDay() + 6) % 7;
    const startOfWeek = new Date(startOfDay);
    startOfWeek.setDate(startOfDay.getDate() - daySinceMon);

    const aggregate = await this.answersRepo
      .createQueryBuilder('a')
      .innerJoin('a.exam', 'e')
      .where('e.userId = :userId', { userId })
      .select('COUNT(*)', 'total')
      .addSelect(
        'SUM(CASE WHEN a.isCorrect = true THEN 1 ELSE 0 END)',
        'correct',
      )
      .addSelect('COALESCE(SUM(a.timeSpentMs),0)', 'timeMs')
      // ExamAnswer has no `createdAt` — the timestamp is `answeredAt` (column
      // `answered_at`). The original code used `a.createdAt`, which TypeORM
      // can't resolve to a real property, so it leaks straight into the SQL
      // and Postgres rejects it with `column a.createdat does not exist`.
      .addSelect('COUNT(*) FILTER (WHERE a.answeredAt >= :dayStart)', 'today')
      .addSelect('COUNT(*) FILTER (WHERE a.answeredAt >= :weekStart)', 'week')
      .addSelect(
        'COALESCE(SUM(a.timeSpentMs) FILTER (WHERE a.answeredAt >= :dayStart), 0)',
        'todayMs',
      )
      .setParameters({
        dayStart: startOfDay.toISOString(),
        weekStart: startOfWeek.toISOString(),
      })
      .getRawOne<{
        total: string;
        correct: string;
        timeMs: string;
        today: string;
        week: string;
        todayMs: string;
      }>();

    const total = parseInt(aggregate?.total ?? '0', 10);
    const correct = parseInt(aggregate?.correct ?? '0', 10);
    const today = parseInt(aggregate?.today ?? '0', 10);
    const week = parseInt(aggregate?.week ?? '0', 10);
    const todayMs = parseInt(aggregate?.todayMs ?? '0', 10);

    // Streak columns aren't yet on the User entity — default to zeros and
    // revisit when the streaks feature gets its own migration + tracking
    // job. Daily goal constant at 20 per day (spec §6.3) until we ship
    // user-configurable goals.
    const dailyGoal = 20;
    const xp = correct * 10;
    const { level, into, needed } = levelFromXp(xp);

    return {
      totalQuestionsAttempted: total,
      accuracy: total > 0 ? Number(((correct / total) * 100).toFixed(1)) : 0,
      streakDays: 0,
      longestStreak: 0,
      xp,
      level,
      xpToNextLevel: Math.max(0, needed - into),
      questionsThisWeek: week,
      dailyGoal,
      dailyGoalProgress: Math.min(dailyGoal, today),
      studyMinutesToday: Math.round(todayMs / 60_000),
    };
  }
}

/**
 * Mirrors mobile/lib/utils.ts `levelFromXp` — keep the two in sync. Level
 * bands: L1 needs 100, each subsequent level adds +25 to the band size.
 */
function levelFromXp(xp: number): {
  level: number;
  into: number;
  needed: number;
} {
  let level = 1;
  let needed = 100;
  let remaining = xp;
  while (remaining >= needed) {
    remaining -= needed;
    level += 1;
    needed += 25;
  }
  return { level, into: remaining, needed };
}
