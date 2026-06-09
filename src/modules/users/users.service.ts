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
import { ChangePasswordDto } from '../auth/dto/change-password.dto';

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
