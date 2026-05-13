import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { hashPassword, verifyPassword } from '../../common/utils/password.util';
import { User } from './entities/user.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { UserSubjectProgress } from '../progress/entities/user-subject-progress.entity';
import { Exam } from '../exams/entities/exam.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
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
  ) {}

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
