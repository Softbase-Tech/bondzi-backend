import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { Exam } from './entities/exam.entity';
import { ExamAnswer } from './entities/exam-answer.entity';
import { Question } from '../questions/entities/question.entity';
import { Option } from '../questions/entities/option.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { UserSubjectProgress } from '../progress/entities/user-subject-progress.entity';
import { User } from '../users/entities/user.entity';
import { SrsService } from '../srs/srs.service';
import { GamificationService } from '../gamification/gamification.service';
import { StreakService } from '../gamification/streak.service';
import { ReferralsService } from '../referrals/referrals.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import {
  Difficulty,
  ExamMode,
  ExamStatus,
  QuestionPool,
} from '../../common/types/enums';
import {
  CreateExamDto,
  ExamDifficultyFilter,
  SubmitAnswerDto,
} from './dto/create-exam.dto';
import {
  ExamSessionResponse,
  toExamSessionResponse,
} from './serializers/exam-session.serializer';
import {
  ExamResultResponse,
  toExamResultResponse,
} from './serializers/exam-result.serializer';
import { Topic } from '../subjects/entities/topic.entity';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { HistoryQueryDto } from './dto/history-query.dto';
import {
  ExamHistoryRow,
  toExamHistoryRow,
} from './serializers/exam-history.serializer';

@Injectable()
export class ExamsService {
  constructor(
    @InjectRepository(Exam) private readonly examsRepo: Repository<Exam>,
    @InjectRepository(ExamAnswer)
    private readonly answersRepo: Repository<ExamAnswer>,
    @InjectRepository(Question)
    private readonly questionsRepo: Repository<Question>,
    @InjectRepository(Option) private readonly optionsRepo: Repository<Option>,
    @InjectRepository(Subject)
    private readonly subjectsRepo: Repository<Subject>,
    @InjectRepository(UserSubjectProgress)
    private readonly progressRepo: Repository<UserSubjectProgress>,
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    private readonly srs: SrsService,
    private readonly gamification: GamificationService,
    private readonly streak: StreakService,
    private readonly referrals: ReferralsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly dataSource: DataSource,
  ) {}

  /** Create an exam session — server selects questions based on filter + mode. */
  async create(
    userId: string,
    dto: CreateExamDto,
  ): Promise<ExamSessionResponse> {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const desiredCount =
      dto.questionCount ?? (dto.mode === ExamMode.PAST_PAPER ? 50 : 20);
    const qb = this.questionsRepo
      .createQueryBuilder('q')
      .leftJoinAndSelect('q.options', 'o')
      // Stimulus is the shared passage some questions hang off (reading
      // comprehension, source-analysis, etc.). Without joining it here the
      // serializer emits `stimulus: null` and the mobile renders questions
      // missing the passage they refer to.
      .leftJoinAndSelect('q.stimulus', 'stim')
      .where("q.status = 'active'")
      .andWhere('q.examType = :et', { et: user.examType });

    const filter = dto.subjectFilter ?? {};
    if (filter.subjectIds?.length)
      qb.andWhere('q.subjectId IN (:...sids)', { sids: filter.subjectIds });
    if (filter.topicIds?.length)
      qb.andWhere('q.topicId IN (:...tids)', { tids: filter.topicIds });
    if (filter.years?.length)
      qb.andWhere('q.year IN (:...years)', { years: filter.years });
    if (filter.wassecPaper)
      qb.andWhere('q.wassecPaper = :paper', { paper: filter.wassecPaper });

    // Difficulty filter applies to practice/drill modes only. Past papers are
    // canonical — we never filter their questions by difficulty.
    if (
      dto.mode !== ExamMode.PAST_PAPER &&
      dto.difficulty &&
      dto.difficulty !== ExamDifficultyFilter.MIXED
    ) {
      const difficultyEnum: Difficulty =
        dto.difficulty === ExamDifficultyFilter.EASY
          ? Difficulty.EASY
          : dto.difficulty === ExamDifficultyFilter.HARD
            ? Difficulty.HARD
            : Difficulty.MEDIUM;
      qb.andWhere('q.difficulty = :diff', { diff: difficultyEnum });
    }

    // focusWeak biases practice selection toward subjects the user has <50%
    // rolling accuracy on. We gather weak subject IDs first, then narrow the
    // filter if the current subject filter allows it. If no weak subjects are
    // found we leave the query untouched — the user has no "weak" areas yet.
    if (dto.mode !== ExamMode.PAST_PAPER && dto.focusWeak) {
      const weak = await this.progressRepo
        .createQueryBuilder('p')
        .select('p.subject_id', 'subjectId')
        .where('p.user_id = :uid', { uid: userId })
        .andWhere('p.questions_seen >= 5')
        .andWhere('p.questions_correct::float / p.questions_seen < 0.5')
        .getRawMany<{ subjectId: string }>();
      const weakIds = weak.map((w) => w.subjectId);
      if (weakIds.length > 0) {
        const intersect = filter.subjectIds?.length
          ? weakIds.filter((id) => filter.subjectIds!.includes(id))
          : weakIds;
        if (intersect.length > 0) {
          qb.andWhere('q.subjectId IN (:...weakSids)', {
            weakSids: intersect,
          });
        }
      }
    }

    // Past papers follow canonical order; practice/drill randomises.
    if (dto.mode === ExamMode.PAST_PAPER) {
      qb.orderBy('q.wassecPaper', 'ASC')
        .addOrderBy('q.section', 'ASC')
        .addOrderBy('q.createdAt', 'ASC');
    } else {
      qb.orderBy('random()');
    }
    // `.take()` (not `.limit()`) — TypeORM with `leftJoinAndSelect` returns
    // (question × option) joined rows, so a raw SQL `LIMIT 50` would cap at
    // 50 *rows*, deduping to ~12 unique questions. `.take()` rewrites the
    // query as `IN (SELECT id FROM questions ... LIMIT N)` so the cap
    // applies to entities. See https://github.com/typeorm/typeorm/issues/4742.
    qb.take(desiredCount);

    const questions = await qb.getMany();
    if (questions.length === 0)
      throw new BadRequestException('No questions match this filter');

    const exam = this.examsRepo.create({
      userId,
      examType: user.examType,
      mode: dto.mode,
      status: ExamStatus.IN_PROGRESS,
      subjectFilter: dto.subjectFilter as unknown as Record<string, unknown>,
      questionIds: questions.map((q) => q.id),
      durationSeconds: dto.durationSeconds ?? null,
      totalQuestions: questions.length,
      startedAt: new Date(),
    });
    await this.examsRepo.save(exam);

    const hasActiveSubscription =
      await this.subscriptions.hasActiveSubscription(userId);
    return toExamSessionResponse(exam, questions, { hasActiveSubscription });
  }

  async getOne(userId: string, examId: string): Promise<ExamSessionResponse> {
    const exam = await this.examsRepo.findOne({ where: { id: examId } });
    if (!exam) throw new NotFoundException('Exam not found');
    if (exam.userId !== userId) throw new ForbiddenException('Not your exam');

    const answered = await this.answersRepo.find({
      where: { examId },
      select: ['questionId'],
    });
    const answeredSet = new Set(answered.map((a) => a.questionId));
    const remaining = exam.questionIds.filter((id) => !answeredSet.has(id));

    const rows =
      remaining.length > 0
        ? await this.questionsRepo.find({
            where: { id: In(remaining) },
            // Load the stimulus passage alongside options — same reason as in
            // createExam. Without it, resumed sessions hide the passage that
            // explains what the question is asking about.
            relations: ['options', 'stimulus'],
          })
        : [];
    const byId = new Map(rows.map((q) => [q.id, q] as const));
    const ordered = remaining
      .map((id) => byId.get(id))
      .filter((q): q is Question => Boolean(q));

    const hasActiveSubscription =
      await this.subscriptions.hasActiveSubscription(userId);
    return toExamSessionResponse(exam, ordered, { hasActiveSubscription });
  }

  /**
   * Answer submission — the spec §5.5 "critical detail" flow.
   *
   * Executed in a single transaction:
   *   1. Validate exam ownership + in_progress + question membership + no prior answer
   *   2. Look up correct option
   *   3. Insert ExamAnswer
   *   4. Atomically bump questions.times_answered (+times_correct)
   *   5. Upsert SRS card with simplified quality
   * Then (outside tx):
   *   6. On wrong: check Redis for cached explanation; if miss, enqueue AI job.
   *
   * Response: { isCorrect, correctOptionId, explanation? } — the correct
   * option id is only revealed AFTER the answer is committed.
   */
  async submitAnswer(userId: string, examId: string, dto: SubmitAnswerDto) {
    return this.dataSource
      .transaction(async (em) => {
        const examsRepo = em.getRepository(Exam);
        const answersRepo = em.getRepository(ExamAnswer);
        const questionsRepo = em.getRepository(Question);
        const optionsRepo = em.getRepository(Option);

        const exam = await examsRepo.findOne({ where: { id: examId } });
        if (!exam) throw new NotFoundException('Exam not found');
        if (exam.userId !== userId)
          throw new ForbiddenException('Not your exam');
        if (exam.status !== ExamStatus.IN_PROGRESS) {
          throw new ConflictException('Exam is not in progress');
        }
        if (!exam.questionIds.includes(dto.questionId)) {
          throw new BadRequestException('Question not part of this exam');
        }

        const existing = await answersRepo.findOne({
          where: { examId, questionId: dto.questionId },
        });
        if (existing)
          throw new ConflictException(
            'Answer already submitted for this question',
          );

        const correctOption = await optionsRepo.findOne({
          where: { questionId: dto.questionId, isCorrect: true },
        });
        if (!correctOption)
          throw new NotFoundException('No correct option defined');

        const isCorrect = dto.selectedOptionId
          ? dto.selectedOptionId === correctOption.id
          : false;

        const answer = answersRepo.create({
          examId,
          questionId: dto.questionId,
          selectedOptionId: dto.selectedOptionId ?? null,
          typedAnswer: dto.typedAnswer ?? null,
          isCorrect,
          timeSpentMs: dto.timeSpentMs ?? null,
        });
        await answersRepo.save(answer);

        // Atomic counter bump — never re-read then write.
        await questionsRepo
          .createQueryBuilder()
          .update(Question)
          .set({
            timesAnswered: () => '"times_answered" + 1',
            timesCorrect: () =>
              isCorrect ? '"times_correct" + 1' : '"times_correct"',
          })
          .where('id = :id', { id: dto.questionId })
          .execute();

        return {
          isCorrect,
          correctOptionId: correctOption.id,
          questionPool: exam.questionPool,
        };
      })
      .then(async ({ isCorrect, correctOptionId, questionPool }) => {
        // Post-commit side effects — failures must not roll back the answer.
        await this.srs
          .upsertFromAnswer(userId, dto.questionId, isCorrect)
          .catch(() => void 0);

        let xpAwarded: Awaited<
          ReturnType<GamificationService['awardXp']>
        > | null = null;
        if (isCorrect) {
          const eventKey =
            questionPool === QuestionPool.PM_TEST
              ? 'correct_pm_test'
              : 'correct_past_paper';
          xpAwarded = await this.gamification
            .awardXp(userId, eventKey, dto.questionId)
            .catch(() => null);
        }

        // Fire-and-forget referral qualification check (threshold = 10 answers).
        this.referrals.checkQualification(userId).catch(() => void 0);

        return { isCorrect, correctOptionId, xp: xpAwarded };
      });
  }

  async complete(userId: string, examId: string): Promise<Exam> {
    const exam = await this.examsRepo.findOne({ where: { id: examId } });
    if (!exam) throw new NotFoundException('Exam not found');
    if (exam.userId !== userId) throw new ForbiddenException('Not your exam');
    if (exam.status === ExamStatus.COMPLETED) return exam;

    const answers = await this.answersRepo.find({ where: { examId } });
    const correct = answers.filter((a) => a.isCorrect).length;
    const total = exam.questionIds.length;
    const percent =
      total > 0 ? Number(((correct / total) * 100).toFixed(2)) : 0;

    exam.score = correct;
    exam.totalQuestions = total;
    exam.percentScore = percent.toFixed(2);
    exam.status = ExamStatus.COMPLETED;
    exam.completedAt = new Date();

    // v2 XP: completion bonus (+ perfect bonus), streak bump, subject progress.
    // All post-transactional — failures never block marking the exam complete.
    const completionXp = await this.gamification
      .awardXp(userId, 'exam_complete', exam.id)
      .catch(() => null);
    let perfectXp: Awaited<ReturnType<GamificationService['awardXp']>> | null =
      null;
    if (total > 0 && correct === total) {
      perfectXp = await this.gamification
        .awardXp(userId, 'exam_perfect', exam.id)
        .catch(() => null);
    }
    exam.xpEarned = (completionXp?.xpAmount ?? 0) + (perfectXp?.xpAmount ?? 0);
    await this.examsRepo.save(exam);

    await this.streak.recordStudyDay(userId).catch(() => void 0);
    await this.referrals.checkQualification(userId).catch(() => void 0);

    await this.updateSubjectProgress(userId, exam, answers);
    return exam;
  }

  async abandon(userId: string, examId: string): Promise<void> {
    const exam = await this.examsRepo.findOne({ where: { id: examId } });
    if (!exam) throw new NotFoundException('Exam not found');
    if (exam.userId !== userId) throw new ForbiddenException('Not your exam');
    exam.status = ExamStatus.ABANDONED;
    await this.examsRepo.save(exam);
  }

  async getResult(userId: string, examId: string): Promise<ExamResultResponse> {
    const exam = await this.examsRepo.findOne({ where: { id: examId } });
    if (!exam) throw new NotFoundException('Exam not found');
    if (exam.userId !== userId) throw new ForbiddenException('Not your exam');

    const answers = await this.answersRepo.find({
      where: { examId },
      relations: ['question', 'question.options', 'selectedOption'],
    });

    const topicIds = Array.from(
      new Set(
        answers
          .map((a) => a.question?.topicId)
          .filter((id): id is string => typeof id === 'string'),
      ),
    );
    const topics = topicIds.length
      ? await this.dataSource
          .getRepository(Topic)
          .find({ where: { id: In(topicIds) } })
      : [];

    return toExamResultResponse(exam, answers, topics);
  }

  /**
   * Most-recently-touched in-progress exam, or `null` if there isn't one.
   * Powers the home-screen "Continue where you left off" card. Returns
   * the same `ExamSession` shape as `getOne` so the mobile can reuse the
   * exam screen straight off the response without a second fetch.
   */
  async resumeMostRecent(userId: string): Promise<ExamSessionResponse | null> {
    const exam = await this.examsRepo.findOne({
      where: { userId, status: ExamStatus.IN_PROGRESS },
      order: { startedAt: 'DESC' },
    });
    if (!exam) return null;
    return this.getOne(userId, exam.id);
  }

  async history(
    userId: string,
    query: HistoryQueryDto,
  ): Promise<PaginatedResult<ExamHistoryRow>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.examsRepo
      .createQueryBuilder('e')
      .where('e.user_id = :uid', { uid: userId })
      .andWhere('e.status = :status', {
        status: query.status ?? ExamStatus.COMPLETED,
      });

    if (query.subjectId) {
      // Postgres jsonb path operator — match if subject_filter.subjectIds
      // contains the requested UUID. Indexed via the GIN index on
      // exam.subject_filter (added with the v2 schema).
      qb.andWhere(
        `(e.subject_filter -> 'subjectIds') @> to_jsonb(ARRAY[:sid]::uuid[])`,
        { sid: query.subjectId },
      );
    }
    if (query.fromDate) {
      qb.andWhere('e.completed_at >= :from', { from: query.fromDate });
    }
    if (query.toDate) {
      qb.andWhere('e.completed_at <= :to', { to: query.toDate });
    }
    if (query.mode) {
      qb.andWhere('e.mode = :mode', { mode: query.mode });
    }

    qb.orderBy('e.completed_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [exams, total] = await qb.getManyAndCount();

    // Resolve all subject UUIDs across the page in one shot, then index by
    // id so each row's `subjects[]` is a cheap map lookup.
    const subjectIds = new Set<string>();
    for (const e of exams) {
      const filter = (e.subjectFilter ?? {}) as { subjectIds?: string[] };
      if (Array.isArray(filter.subjectIds)) {
        for (const sid of filter.subjectIds) subjectIds.add(sid);
      }
    }
    const subjectIndex = new Map<string, Subject>();
    if (subjectIds.size > 0) {
      const rows = await this.subjectsRepo.find({
        where: { id: In(Array.from(subjectIds)) },
      });
      for (const s of rows) subjectIndex.set(s.id, s);
    }

    return {
      items: exams.map((e) => toExamHistoryRow(e, subjectIndex)),
      total,
      nextCursor: null,
    };
  }

  /** Update denormalised per-subject progress (spec §4.2 UserSubjectProgress). */
  private async updateSubjectProgress(
    userId: string,
    exam: Exam,
    answers: ExamAnswer[],
  ): Promise<void> {
    const questions = await this.questionsRepo.find({
      where: { id: In(exam.questionIds) },
    });
    const bySubject = new Map<
      string,
      {
        seen: number;
        correct: number;
        time: number;
        topicAcc: Map<string, { seen: number; correct: number }>;
      }
    >();

    for (const a of answers) {
      const q = questions.find((x) => x.id === a.questionId);
      if (!q) continue;
      const bucket = bySubject.get(q.subjectId) ?? {
        seen: 0,
        correct: 0,
        time: 0,
        topicAcc: new Map<string, { seen: number; correct: number }>(),
      };
      bucket.seen += 1;
      if (a.isCorrect) bucket.correct += 1;
      bucket.time += a.timeSpentMs ?? 0;
      if (q.topicId) {
        const tacc = bucket.topicAcc.get(q.topicId) ?? { seen: 0, correct: 0 };
        tacc.seen += 1;
        if (a.isCorrect) tacc.correct += 1;
        bucket.topicAcc.set(q.topicId, tacc);
      }
      bySubject.set(q.subjectId, bucket);
    }

    for (const [subjectId, bucket] of bySubject) {
      let progress = await this.progressRepo.findOne({
        where: { userId, subjectId },
      });
      if (!progress) {
        progress = this.progressRepo.create({ userId, subjectId });
      }
      progress.questionsSeen += bucket.seen;
      progress.questionsCorrect += bucket.correct;
      progress.totalTimeMs = String(
        BigInt(progress.totalTimeMs ?? '0') + BigInt(bucket.time),
      );
      progress.lastStudiedAt = new Date();
      const nextTopicAcc = progress.topicAccuracy ?? {};
      for (const [topicId, tacc] of bucket.topicAcc) {
        const current = nextTopicAcc[topicId] ?? { seen: 0, correct: 0 };
        nextTopicAcc[topicId] = {
          seen: current.seen + tacc.seen,
          correct: current.correct + tacc.correct,
        };
      }
      progress.topicAccuracy = nextTopicAcc;
      await this.progressRepo.save(progress);
    }
  }
}
