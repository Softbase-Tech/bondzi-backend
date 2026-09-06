import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { Exam } from './entities/exam.entity';
import { ExamAnswer } from './entities/exam-answer.entity';
import { Question } from '../questions/entities/question.entity';
import { Option } from '../questions/entities/option.entity';
import { PmTestOption } from '../pm-test/entities/pm-test-option.entity';
import { PmTestQuestion } from '../pm-test/entities/pm-test-question.entity';
import { toStudentQuestionFromPmTest } from '../pm-test/serializers/pm-test.serializer';
import { Subject } from '../subjects/entities/subject.entity';
import { UserSubjectProgress } from '../progress/entities/user-subject-progress.entity';
import { User } from '../users/entities/user.entity';
import { SrsService } from '../srs/srs.service';
import { GamificationService } from '../gamification/gamification.service';
import { StreakService } from '../gamification/streak.service';
import { WeaknessNarrativeService } from '../progress/weakness-narrative.service';
import { PartnerCommissionsService } from '../partners/partner-commissions.service';
import { ReferralsService } from '../referrals/referrals.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { AiService } from '../ai/ai.service';
import { RejectLogService } from '../ai/reject-log.service';
import { KnowledgeRetrievalService } from '../syllabus/knowledge-retrieval.service';
import { validateNarrativeEnvelope } from '../ai/validation/narrative-envelope.validator';
import {
  STUDENT_CITATION_RULES,
  STUDENT_DATA_RULES,
  STUDENT_JSON_ENVELOPE,
  STUDENT_TONE_RULES,
} from '../ai/instruction-layer/student-facing.shell';
import { ConfigService } from '@nestjs/config';
import {
  AccountType,
  AiAction,
  Difficulty,
  EntitlementService,
  ExamMode,
  ExamStatus,
  QuestionPool,
  QuestionStatus,
  SubjectCategory,
  questionPoolFor,
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
  private readonly logger = new Logger(ExamsService.name);

  constructor(
    @InjectRepository(Exam) private readonly examsRepo: Repository<Exam>,
    @InjectRepository(ExamAnswer)
    private readonly answersRepo: Repository<ExamAnswer>,
    @InjectRepository(Question)
    private readonly questionsRepo: Repository<Question>,
    @InjectRepository(Option) private readonly optionsRepo: Repository<Option>,
    @InjectRepository(PmTestQuestion)
    private readonly pmTestQRepo: Repository<PmTestQuestion>,
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
    private readonly entitlements: EntitlementsService,
    private readonly ai: AiService,
    private readonly rejectLog: RejectLogService,
    private readonly knowledge: KnowledgeRetrievalService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly partnerCommissions: PartnerCommissionsService,
    private readonly weaknessNarratives: WeaknessNarrativeService,
  ) {}

  /** Create an exam session — server selects questions based on filter + mode. */
  async create(
    userId: string,
    dto: CreateExamDto,
  ): Promise<ExamSessionResponse> {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    await this.subscriptions.assertCanStudySubjects(
      userId,
      user.examType,
      dto.subjectFilter?.subjectIds,
    );

    // Cross-field validation for filter × mode. Kept in the service (rather
    // than the DTO) because it references relationships between fields, not
    // shape-of-a-single-field constraints.
    const filter = dto.subjectFilter ?? {};
    if (filter.syllabusTopicIds?.length && dto.mode !== ExamMode.PM_TEST) {
      throw new BadRequestException(
        'syllabusTopicIds is only valid with mode="pm_test". Past-paper questions are not tagged with syllabus_topic_id.',
      );
    }

    if (dto.mode === ExamMode.PM_TEST) {
      return this.createPmTestSession(user, dto, filter);
    }

    if (dto.mode === ExamMode.MOCK_EXAM) {
      return this.createMockExamSession(user, dto, filter);
    }

    // Past-paper metering by subject.category. Free tier: CORE is
    // unlimited, ELECTIVE is 10/day; Plus/Pro are unlimited on both.
    // The two setup screens always pass a single subjectId (see
    // /past-papers/setup + WeakTopicsCard callers). If a caller ever
    // passes multiple subjects that span both categories, we meter
    // against the more restrictive of the two (ELECTIVE) — that's the
    // conservative default. Zero-subject filters skip metering, since
    // "no subject" means "cross-subject browse" which the DTO doesn't
    // actually surface from any client.
    if (dto.mode === ExamMode.PAST_PAPER && filter.subjectIds?.length) {
      const service = await this.resolvePastPaperService(filter.subjectIds);
      await this.entitlements.assertAndConsume(user.id, service);
    }

    const desiredCount =
      dto.questionCount ?? (dto.mode === ExamMode.PAST_PAPER ? 50 : 20);

    // Two-step selection:
    //   1. Resolve a list of question IDs that match the filter, ordered
    //      and limited as required.
    //   2. Load the full Question entities (with options + stimulus relations)
    //      for those IDs and reattach in the original order.
    //
    // Why not a single query with `leftJoinAndSelect(...).take()`? TypeORM
    // rewrites that as an ID subquery with `SELECT DISTINCT q.id ... ORDER BY
    // <criteria> LIMIT N`. PostgreSQL rejects `ORDER BY random()` in that
    // shape ("for SELECT DISTINCT, ORDER BY expressions must appear in select
    // list"), which 500s practice mode. Splitting the queries also means we
    // get a deterministic `LIMIT N` on entities without any join-row math.
    const idQb = this.questionsRepo
      .createQueryBuilder('q')
      .select('q.id', 'id')
      .where("q.status = 'active'")
      // NOVDEC students share the WASSCE question pool — remap so they
      // can build practice exams. The exam row itself keeps the user's
      // `novdec` examType for analytics (so we can tell who took it).
      .andWhere('q.examType = :et', { et: questionPoolFor(user.examType) });

    if (filter.subjectIds?.length)
      idQb.andWhere('q.subjectId IN (:...sids)', { sids: filter.subjectIds });
    if (filter.topicIds?.length)
      idQb.andWhere('q.topicId IN (:...tids)', { tids: filter.topicIds });
    if (filter.years?.length)
      idQb.andWhere('q.year IN (:...years)', { years: filter.years });
    if (filter.wassecPaper)
      idQb.andWhere('q.wassecPaper = :paper', { paper: filter.wassecPaper });

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
      idQb.andWhere('q.difficulty = :diff', { diff: difficultyEnum });
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
          idQb.andWhere('q.subjectId IN (:...weakSids)', {
            weakSids: intersect,
          });
        }
      }
    }

    // Past papers follow canonical order; practice/drill randomises.
    if (dto.mode === ExamMode.PAST_PAPER) {
      idQb
        .orderBy('q.wassecPaper', 'ASC')
        .addOrderBy('q.section', 'ASC')
        .addOrderBy('q.createdAt', 'ASC');
    } else {
      idQb.orderBy('RANDOM()');
    }
    idQb.limit(desiredCount);

    const idRows = await idQb.getRawMany<{ id: string }>();
    if (idRows.length === 0)
      throw new BadRequestException('No questions match this filter');
    const orderedIds = idRows.map((r) => r.id);

    const loaded = await this.questionsRepo.find({
      where: { id: In(orderedIds) },
      relations: ['options', 'stimulus'],
    });
    const byId = new Map(loaded.map((q) => [q.id, q] as const));
    const questions = orderedIds
      .map((id) => byId.get(id))
      .filter((q): q is Question => Boolean(q));

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

    // Plus or Pro on the user's CURRENT level is what unlocks the
    // exam-session response shape (full explanations etc). The `user`
    // object was already loaded at the top of this method.
    const hasActiveSubscription = await this.subscriptions.hasEntitlement(
      userId,
      user.examType,
      AccountType.PLUS,
    );
    return toExamSessionResponse(exam, questions, { hasActiveSubscription });
  }

  /**
   * Level-test (PM Test) session creation. Draws from `pm_test_questions`
   * (AI-generated, admin-reviewed → status='active') filtered by:
   *
   *   - `subjectIds` (usually one — the picker is per-subject)
   *   - `syllabusTopicIds` (optional — omit for a random session)
   *   - user's `formLevel` (implicit; NOVDEC has NULL form and shares the
   *     WASSCE pool via `questionPoolFor`)
   *
   * Sets `exam.question_pool = PM_TEST` so the answer-submission path
   * routes to `pm_test_options` for grading (see `submitAnswer` line ~308)
   * and XP awards land in the `correct_pm_test` bucket (see `complete`
   * line ~403).
   *
   * The returned wire shape is `ExamSessionResponse` — same as past-paper
   * sessions — because the mobile exam runner is agnostic to source. See
   * `toStudentQuestionFromPmTest` for the shape adapter.
   */
  /**
   * Resolves which past-paper entitlement key to meter against. Reads the
   * category off the passed subjects and returns the more-restrictive
   * (ELECTIVE) when the batch mixes core + elective. Falls back to CORE
   * when the subjects are unknown — safer than blowing up mid-request.
   */
  private async resolvePastPaperService(
    subjectIds: string[],
  ): Promise<EntitlementService> {
    const subjects = await this.subjectsRepo.find({
      where: { id: In(subjectIds) },
      select: ['id', 'category'],
    });
    if (subjects.length === 0) {
      this.logger.warn(
        `[past-paper-meter] no subjects resolved for [${subjectIds.join(', ')}] — defaulting to CORE`,
      );
      return EntitlementService.PAST_PAPERS_CORE;
    }
    const hasElective = subjects.some(
      (s) => s.category === SubjectCategory.ELECTIVE,
    );
    return hasElective
      ? EntitlementService.PAST_PAPERS_ELECTIVE
      : EntitlementService.PAST_PAPERS_CORE;
  }

  private async createPmTestSession(
    user: User,
    dto: CreateExamDto,
    filter: NonNullable<CreateExamDto['subjectFilter']>,
  ): Promise<ExamSessionResponse> {
    if (filter.topicIds?.length) {
      throw new BadRequestException(
        'topicIds targets past-paper topics — use syllabusTopicIds for pm_test mode.',
      );
    }
    if (filter.years?.length || filter.wassecPaper) {
      throw new BadRequestException(
        'years / wassecPaper are past-paper filters and cannot be combined with mode="pm_test".',
      );
    }

    // Level-test entitlement. Consumed BEFORE any DB write so a rejected
    // attempt doesn't create a session row. The atomic UPSERT inside
    // assertAndConsume rolls back its own counter increment when the cap
    // is breached (see entitlements.service). Free=20/day, Plus=80/day,
    // Pro=∞ per the tier_services seed in migration 1960.
    //
    // Trade-off: if session creation below fails after this call, the user
    // loses one quota point for a failed attempt. Preferred over the
    // alternative (orphan session row on entitlement failure) because the
    // failure path is rare (subject filter with zero matching questions).
    await this.entitlements.assertAndConsume(
      user.id,
      EntitlementService.LEVEL_TESTS,
    );

    const desiredCount = dto.questionCount ?? 20;

    const idQb = this.pmTestQRepo
      .createQueryBuilder('q')
      .select('q.id', 'id')
      .where('q.status = :st', { st: QuestionStatus.ACTIVE })
      // NOVDEC students share the WASSCE PM-test pool.
      .andWhere('q.exam_type = :et', { et: questionPoolFor(user.examType) });

    if (filter.subjectIds?.length) {
      idQb.andWhere('q.subject_id IN (:...sids)', { sids: filter.subjectIds });
    }
    if (filter.syllabusTopicIds?.length) {
      idQb.andWhere('q.syllabus_topic_id IN (:...stids)', {
        stids: filter.syllabusTopicIds,
      });
    }
    // NOVDEC has NULL formLevel; skip the filter for them (their pool is
    // WASSCE-tagged and formLevel-agnostic on the resit path).
    if (user.formLevel != null) {
      idQb.andWhere('q.form_level = :fl', { fl: user.formLevel });
    }
    // Difficulty. 'mixed' (default) returns the full range; anything else
    // is a concrete constraint against pm_test_questions.difficulty. Silent
    // no-op before this — the mobile difficulty picker shipped as a lie.
    if (dto.difficulty && dto.difficulty !== ExamDifficultyFilter.MIXED) {
      const difficultyEnum: Difficulty =
        dto.difficulty === ExamDifficultyFilter.EASY
          ? Difficulty.EASY
          : dto.difficulty === ExamDifficultyFilter.HARD
            ? Difficulty.HARD
            : Difficulty.MEDIUM;
      idQb.andWhere('q.difficulty = :diff', { diff: difficultyEnum });
    }

    idQb.orderBy('RANDOM()').limit(desiredCount);

    const idRows = await idQb.getRawMany<{ id: string }>();
    if (idRows.length === 0) {
      throw new BadRequestException(
        'No level-test questions match this filter yet — try a different topic or ask an admin to generate more.',
      );
    }
    const orderedIds = idRows.map((r) => r.id);

    const loaded = await this.pmTestQRepo.find({
      where: { id: In(orderedIds) },
      relations: ['options'],
    });
    const byId = new Map(loaded.map((q) => [q.id, q] as const));
    const questions = orderedIds
      .map((id) => byId.get(id))
      .filter((q): q is PmTestQuestion => Boolean(q));

    const exam = this.examsRepo.create({
      userId: user.id,
      examType: user.examType,
      mode: dto.mode,
      status: ExamStatus.IN_PROGRESS,
      questionPool: QuestionPool.PM_TEST,
      subjectFilter: dto.subjectFilter as unknown as Record<string, unknown>,
      questionIds: questions.map((q) => q.id),
      durationSeconds: dto.durationSeconds ?? null,
      totalQuestions: questions.length,
      startedAt: new Date(),
    });
    await this.examsRepo.save(exam);

    const hasActiveSubscription = await this.subscriptions.hasEntitlement(
      user.id,
      user.examType,
      AccountType.PLUS,
    );
    const studentQuestions = questions.map((q) =>
      toStudentQuestionFromPmTest(q, { hasActiveSubscription }),
    );
    // toExamSessionResponse takes past-paper Question entities; call the
    // small shim below to build the same shape from pre-mapped items.
    return {
      id: exam.id,
      userId: exam.userId,
      mode: exam.mode,
      questionCount: exam.totalQuestions ?? studentQuestions.length,
      durationSeconds: exam.durationSeconds,
      startedAt: exam.startedAt.toISOString(),
      completedAt: null,
      abandonedAt: null,
      score: null,
      grade: null,
      questions: studentQuestions,
      subjectIds: Array.isArray(filter.subjectIds) ? filter.subjectIds : [],
    };
  }

  /**
   * Mock-exam session — timed full-length simulation. Draws from the
   * past-paper `questions` table (same pool the mode='past_paper'
   * branch queries) BUT:
   *   - meters against the separate MOCK_EXAMS entitlement so a Free
   *     student who accidentally taps "Mock exam" doesn't burn one of
   *     their 10 daily elective past-paper points;
   *   - forces a 3-hour timer regardless of what the client sends
   *     (WASSCE Paper 1 convention);
   *   - fixes the count at 50 questions (the WAEC-style Paper 1
   *     length) — clients can't shrink it into a "mini mock";
   *   - refuses topic / year / paper filters — a mock is deliberately
   *     unpredictable to simulate exam-day conditions.
   *
   * `question_pool` stays PAST_PAPER so the answer-submission +
   * grading paths route to the shared `options` table without any
   * new branching.
   */
  private async createMockExamSession(
    user: User,
    dto: CreateExamDto,
    filter: NonNullable<CreateExamDto['subjectFilter']>,
  ): Promise<ExamSessionResponse> {
    if (!filter.subjectIds?.length || filter.subjectIds.length > 1) {
      throw new BadRequestException(
        'Mock exams are single-subject — pass exactly one subjectId.',
      );
    }
    if (
      filter.topicIds?.length ||
      filter.syllabusTopicIds?.length ||
      filter.years?.length ||
      filter.wassecPaper
    ) {
      throw new BadRequestException(
        'Mock exams sample across the whole subject — remove topicIds / syllabusTopicIds / years / wassecPaper.',
      );
    }

    await this.entitlements.assertAndConsume(
      user.id,
      EntitlementService.MOCK_EXAMS,
    );

    const desiredCount = 50;

    const idRows = await this.questionsRepo
      .createQueryBuilder('q')
      .select('q.id', 'id')
      .where("q.status = 'active'")
      .andWhere('q.examType = :et', { et: questionPoolFor(user.examType) })
      .andWhere('q.subjectId = :sid', { sid: filter.subjectIds[0] })
      .orderBy('RANDOM()')
      .limit(desiredCount)
      .getRawMany<{ id: string }>();

    if (idRows.length === 0) {
      throw new BadRequestException(
        'No past-paper questions available for this subject — a mock exam needs a stocked pool.',
      );
    }

    const orderedIds = idRows.map((r) => r.id);
    const loaded = await this.questionsRepo.find({
      where: { id: In(orderedIds) },
      relations: ['options', 'stimulus'],
    });
    const byId = new Map(loaded.map((q) => [q.id, q] as const));
    const questions = orderedIds
      .map((id) => byId.get(id))
      .filter((q): q is Question => Boolean(q));

    const exam = this.examsRepo.create({
      userId: user.id,
      examType: user.examType,
      mode: ExamMode.MOCK_EXAM,
      status: ExamStatus.IN_PROGRESS,
      subjectFilter: filter as unknown as Record<string, unknown>,
      questionIds: questions.map((q) => q.id),
      durationSeconds: 3 * 60 * 60, // 3 hours — WASSCE Paper 1.
      totalQuestions: questions.length,
      startedAt: new Date(),
    });
    await this.examsRepo.save(exam);

    const hasActiveSubscription = await this.subscriptions.hasEntitlement(
      user.id,
      user.examType,
      AccountType.PLUS,
    );
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

    // Gate on the exam's OWN level, not the user's current profile level —
    // a user who switches profile mid-session can still resume the
    // in-progress exam at whatever account they had on its level. Using
    // `exam.examType` also saves a user-row fetch on this hot path.
    const hasActiveSubscription = await this.subscriptions.hasEntitlement(
      userId,
      exam.examType,
      AccountType.PLUS,
    );

    // Discriminate on the exam's declared question_pool. PM-Test rows
    // live on a separate table with a separate options table; querying
    // `questions` (the past-paper table) for a PM-Test exam returned
    // an empty array and left the mobile client stranded on
    // "Loading exam…" indefinitely — the mirror of the pool-branching
    // that `submitAnswer` already does below.
    if (exam.questionPool === QuestionPool.PM_TEST) {
      const loaded =
        remaining.length > 0
          ? await this.pmTestQRepo.find({
              where: { id: In(remaining) },
              relations: ['options'],
            })
          : [];
      const byId = new Map(loaded.map((q) => [q.id, q] as const));
      const ordered = remaining
        .map((id) => byId.get(id))
        .filter((q): q is PmTestQuestion => Boolean(q));
      // Reuse the past-paper serializer for envelope shape, then swap in
      // pm-test-serialized questions. Keeps completedAt / abandonedAt /
      // grade derivation identical for both pools — no divergent copies.
      const envelope = toExamSessionResponse(exam, [], {
        hasActiveSubscription,
      });
      envelope.questions = ordered.map((q) =>
        toStudentQuestionFromPmTest(q, { hasActiveSubscription }),
      );
      envelope.questionCount = exam.totalQuestions ?? exam.questionIds.length;
      return envelope;
    }

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

        // Resolve the option set for this question. exam_answers is
        // shared between past-paper exams (options in `options`) and
        // PM-Test exams (options in `pm_test_options`), discriminated
        // by exam.question_pool. The FK on selected_option_id is
        // dropped so the app layer is the gatekeeper.
        //
        // Defensive fallback: if the primary table for the declared
        // pool returns ZERO rows for this question, try the other
        // table. Covers the case where an exam was created with the
        // wrong question_pool flag (e.g. mixed-source exam, legacy
        // row) — without this, the admin sees "No correct option
        // defined" with no way forward.
        const pmTestRepo = em.getRepository(PmTestOption);
        type OptLite = { id: string; isCorrect: boolean };
        const fetchPast = (): Promise<OptLite[]> =>
          optionsRepo.find({
            where: { questionId: dto.questionId },
            select: { id: true, isCorrect: true },
          });
        const fetchPm = (): Promise<OptLite[]> =>
          pmTestRepo.find({
            where: { questionId: dto.questionId },
            select: { id: true, isCorrect: true },
          });
        const declaredPool = exam.questionPool;
        let allOptions: OptLite[] =
          declaredPool === QuestionPool.PM_TEST
            ? await fetchPm()
            : await fetchPast();
        if (allOptions.length === 0) {
          const fallback =
            declaredPool === QuestionPool.PM_TEST
              ? await fetchPast()
              : await fetchPm();
          if (fallback.length > 0) {
            this.logger.warn(
              `[exam.submit] exam=${examId} q=${dto.questionId} declared pool=${declaredPool} but options found in the OTHER table — using fallback.`,
            );
            allOptions = fallback;
          }
        }
        const correctOption = allOptions.find((o) => o.isCorrect);
        if (!correctOption) {
          this.logger.warn(
            `[exam.submit] exam=${examId} q=${dto.questionId}: no options found in either table.`,
          );
          throw new NotFoundException('No correct option defined');
        }

        if (dto.selectedOptionId) {
          const valid = allOptions.some((o) => o.id === dto.selectedOptionId);
          if (!valid) {
            // Log the mismatch so admins can diagnose stale-cache /
            // race conditions without having to attach a debugger.
            const validIds = allOptions.map((o) => o.id).join(',');
            this.logger.warn(
              `[exam.submit] mismatch exam=${examId} q=${dto.questionId} pool=${declaredPool} sent=${dto.selectedOptionId} valid=[${validIds}]`,
            );
            throw new BadRequestException(
              'selectedOptionId does not belong to this question',
            );
          }
        }

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

        // "Studying today" is answering questions, not finishing exams.
        // Bumping the streak here (not just on complete()) means a user
        // who grinds mid-exam or does a few practice answers per session
        // actually keeps their streak alive. `recordStudyDay` is
        // idempotent per Africa/Accra day, so calling it on every answer
        // is cheap after the first hit — the guarded UPDATE short-circuits.
        await this.streak.recordStudyDay(userId).catch(() => void 0);

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

  async complete(userId: string, examId: string): Promise<ExamResultResponse> {
    const exam = await this.examsRepo.findOne({ where: { id: examId } });
    if (!exam) throw new NotFoundException('Exam not found');
    if (exam.userId !== userId) throw new ForbiddenException('Not your exam');
    // Idempotent: if the exam was already completed (double-tap on
    // submit, mobile re-completing after a previous transient 5xx),
    // return the same result shape — never the raw Exam — so the
    // mobile's Zod strict-parse always sees the same fields.
    if (exam.status === ExamStatus.COMPLETED) {
      return this.getResult(userId, examId);
    }

    const answers = await this.answersRepo.find({ where: { examId } });
    const correct = answers.filter((a) => a.isCorrect).length;
    const total = exam.questionIds.length;

    // Product rule: a session can only be SUBMITTED once every question
    // is answered — no skips. The one exception is a timed session whose
    // clock has run out (the client auto-submits at expiry; rejecting
    // that would trap the student with an unfinishable exam). Abandoning
    // remains available through its own endpoint. 5s of skew grace so a
    // client firing exactly at expiry never loses the race.
    const answeredDistinct = new Set(answers.map((a) => a.questionId)).size;
    const timerExpired =
      exam.durationSeconds != null &&
      Date.now() >=
        exam.startedAt.getTime() + exam.durationSeconds * 1000 - 5_000;
    if (!timerExpired && answeredDistinct < total) {
      throw new BadRequestException(
        `Answer every question before submitting — ${total - answeredDistinct} of ${total} still unanswered.`,
      );
    }

    const percent =
      total > 0 ? Number(((correct / total) * 100).toFixed(2)) : 0;

    exam.score = correct;
    exam.totalQuestions = total;
    exam.percentScore = percent.toFixed(2);
    exam.status = ExamStatus.COMPLETED;
    exam.completedAt = new Date();

    // v2 XP: completion bonus (+ perfect bonus), streak bump, subject progress.
    // All post-transactional — failures never block marking the exam complete.
    //
    // Completion bonus is now scaled by accuracy — a 3/50 finish earns
    // ~1 XP of bonus, a 45/50 finish earns ~18. Per-correct XP (10 or 15
    // per right answer) stays the majority of the payout so the delta on
    // existing balances is small; what changes is that a low-score
    // completion no longer earns the full flat bonus. Perfect stays
    // flat — you got everything right, you get the full perfect bonus.
    const completionMultiplier = total > 0 ? correct / total : 0;
    const completionXp = await this.gamification
      .awardXpMultiplied(userId, 'exam_complete', completionMultiplier, exam.id)
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

    // Partner commission ticks (Streams B + C). Fire in parallel —
    // both are idempotent and both swallow their own errors, so an
    // exam completion never fails because of a partner-side write.
    // Stream B counts toward the signup batch; Stream C fires the
    // answers bonus for paid-Plus attributed users.
    void Promise.all([
      this.partnerCommissions.tickSignupProgress(userId),
      this.partnerCommissions.tickAnswersBonus(userId),
    ]).catch(() => void 0);

    await this.updateSubjectProgress(userId, exam, answers);

    // Drop today's narrative rows (both modes — premium plan §6.3):
    // a personalised narrative describing pre-exam weaknesses must not
    // survive this submission. Regeneration cost stays bounded by the
    // per-(day, scope) entitlement charge.
    void this.weaknessNarratives.invalidateForToday(userId).catch(() => void 0);

    // Build the result-page payload (same shape GET /exams/:id/result
    // returns) so the mobile can render the score screen directly
    // off the complete response without an extra round trip.
    return this.buildResultPayload(exam, answers);
  }

  /**
   * Hydrate the answers' question/option relations + look up topics
   * for the byTopic breakdown, then defer to the shared serializer.
   * Extracted so both `complete` and `getResult` produce identical
   * shapes and the Zod schema on the mobile parses both cleanly.
   */
  private async buildResultPayload(
    exam: Exam,
    answers: ExamAnswer[],
  ): Promise<ExamResultResponse> {
    // `answers` was loaded without relations in `complete()`; reload
    // with question + selectedOption joins so wrongAnswers can show
    // the body / correct option text.
    const hydrated = await this.answersRepo.find({
      where: { examId: exam.id },
      relations: ['question', 'question.options', 'selectedOption'],
    });
    await this.hydratePmTestAnswers(exam, hydrated);
    const topicIds = Array.from(
      new Set(
        hydrated
          .map((a) => a.question?.topicId)
          .filter((id): id is string => typeof id === 'string'),
      ),
    );
    const topics = topicIds.length
      ? await this.dataSource
          .getRepository(Topic)
          .find({ where: { id: In(topicIds) } })
      : [];
    // Mark the unused parameter as intentionally consumed — `answers`
    // is the pre-hydration list used elsewhere in `complete()` for
    // streak/XP/progress; we re-fetch with relations here for the
    // serializer.
    void answers;
    return toExamResultResponse(exam, hydrated, topics);
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
    await this.hydratePmTestAnswers(exam, answers);

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
   * `ExamAnswer.question` is a TypeORM relation to the past-paper
   * `questions` table. For a PM Test exam the id lives in
   * `pm_test_questions` — same UUID namespace, different home — so
   * the relation join returns null and the wrong-answer review card
   * on the result screen renders as "You: —  Correct: —".
   *
   * Fix: after the initial load, if the exam is a PM Test one, fetch
   * the matching pm_test rows and monkey-patch a compatible shape
   * onto `a.question`. The exam-result serializer only reads `body`,
   * `options`, `topicId` from that field — so a duck-typed object
   * with those three keys keeps the serializer signature stable.
   *
   * Same pool-branching family as the submitAnswer / getOne /
   * explanations fixes we shipped earlier — this is the last known
   * read path that hadn't been updated.
   */
  private async hydratePmTestAnswers(
    exam: Exam,
    answers: ExamAnswer[],
  ): Promise<void> {
    if (exam.questionPool !== QuestionPool.PM_TEST) return;
    if (answers.length === 0) return;
    const ids = answers.map((a) => a.questionId);
    const rows = await this.pmTestQRepo.find({
      where: { id: In(ids) },
      relations: ['options'],
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const a of answers) {
      const pm = byId.get(a.questionId);
      if (!pm) continue;
      // Duck-typed: only the fields the serializer needs, cast so
      // TypeORM doesn't reject the assignment. `topicId` is null for
      // pm_test — they use `syllabus_topic_id` — and the topic
      // rollup already handles null topicId cleanly.
      (a as unknown as { question: unknown }).question = {
        id: pm.id,
        body: pm.body,
        options: pm.options,
        topicId: null,
      };
      // If the answer's selectedOption pointer targeted the pm_test
      // options table, the relation join also missed it — resolve
      // from the pm_test option set we just loaded.
      if (!a.selectedOption && a.selectedOptionId) {
        const opt = pm.options.find((o) => o.id === a.selectedOptionId);
        if (opt) {
          (a as unknown as { selectedOption: unknown }).selectedOption = {
            id: opt.id,
            label: opt.label,
            body: opt.body,
            isCorrect: opt.isCorrect,
          };
        }
      }
    }
  }

  /**
   * Post-exam AI breakdown. Dormant surface — the
   * POST_EXAM_AI_BREAKDOWN entitlement is disabled on every tier per
   * the Phase 0.1 seed (migration 1960), so every call today returns
   * 403 from assertAndConsume. When an admin flips the tier to
   * enabled=true, this method starts generating breakdowns without
   * a code change.
   *
   * Cache semantics: once generated, the breakdown lives on
   * `exams.ai_breakdown` and same-exam repeat calls return it without
   * consuming another quota point (same pattern as weakness
   * narratives — one quota per unique thing produced, not per HTTP).
   */
  async generateBreakdown(
    userId: string,
    examId: string,
  ): Promise<{
    breakdown: string;
    recommendations: Array<Record<string, unknown>>;
    generatedAt: string;
    model: string;
    cached: boolean;
  }> {
    const exam = await this.examsRepo.findOne({ where: { id: examId } });
    if (!exam) throw new NotFoundException('Exam not found');
    if (exam.userId !== userId) throw new ForbiddenException('Not your exam');
    if (exam.status !== ExamStatus.COMPLETED) {
      throw new BadRequestException(
        'Breakdown is only available for completed exams.',
      );
    }

    // Cache hit — no entitlement charge, no Bedrock call.
    if (exam.aiBreakdown) {
      return {
        breakdown: exam.aiBreakdown,
        recommendations: exam.aiBreakdownRecommendations ?? [],
        generatedAt:
          exam.aiBreakdownGeneratedAt?.toISOString() ??
          new Date().toISOString(),
        model: exam.aiBreakdownModel ?? 'unknown',
        cached: true,
      };
    }

    await this.entitlements.assertAndConsume(
      userId,
      EntitlementService.POST_EXAM_AI_BREAKDOWN,
    );

    // v2 (premium plan §6.5): resolve every answer to its TOPIC via
    // the two-branch pool join — the old prompt sent truncated stems
    // and asked the model to guess topics it had no way of knowing.
    const topicRows: Array<{
      topic_title: string | null;
      syllabus_topic_id: string | null;
      answered: number;
      correct: number;
    }> = await this.dataSource.query(
      `SELECT coalesce(t.title, st.title)  AS topic_title,
              q2.syllabus_topic_id         AS syllabus_topic_id,
              count(*)::int                AS answered,
              sum(CASE WHEN a.is_correct THEN 1 ELSE 0 END)::int AS correct
         FROM exam_answers a
         LEFT JOIN questions q1         ON a.question_pool = 'past_paper' AND q1.id = a.question_id
         LEFT JOIN pm_test_questions q2 ON a.question_pool = 'pm_test'   AND q2.id = a.question_id
         LEFT JOIN topics t             ON t.id = q1.topic_id
         LEFT JOIN syllabus_topics st   ON st.id = q2.syllabus_topic_id
        WHERE a.exam_id = $1
        GROUP BY 1, 2
        ORDER BY sum(CASE WHEN a.is_correct THEN 1 ELSE 0 END)::float / count(*) ASC`,
      [examId],
    );
    const named = topicRows.filter((r) => r.topic_title);
    const missed = named.filter((r) => r.correct < r.answered);
    const strongest = [...named].reverse().slice(0, 2);

    // The 3 most instructive wrong answers, with chosen vs correct text.
    const mistakes: Array<{
      stem: string;
      chosen: string | null;
      correct: string | null;
      topic_title: string | null;
    }> = await this.dataSource.query(
      `SELECT left(coalesce(q1.body, q2.body), 160) AS stem,
              coalesce(o1.body, o2.body)            AS chosen,
              coalesce(c1.body, c2.body)            AS correct,
              coalesce(t.title, st.title)           AS topic_title
         FROM exam_answers a
         LEFT JOIN questions q1         ON a.question_pool = 'past_paper' AND q1.id = a.question_id
         LEFT JOIN pm_test_questions q2 ON a.question_pool = 'pm_test'   AND q2.id = a.question_id
         LEFT JOIN topics t             ON t.id = q1.topic_id
         LEFT JOIN syllabus_topics st   ON st.id = q2.syllabus_topic_id
         LEFT JOIN options o1           ON a.question_pool = 'past_paper' AND o1.id = a.selected_option_id
         LEFT JOIN pm_test_options o2   ON a.question_pool = 'pm_test'   AND o2.id = a.selected_option_id
         LEFT JOIN options c1           ON a.question_pool = 'past_paper' AND c1.question_id = q1.id AND c1.is_correct
         LEFT JOIN pm_test_options c2   ON a.question_pool = 'pm_test'   AND c2.question_id = q2.id AND c2.is_correct
        WHERE a.exam_id = $1 AND a.is_correct = false
        ORDER BY a.answered_at ASC
        LIMIT 3`,
      [examId],
    );

    // Knowledge-Layer reading citations for the top-2 missed syllabus
    // topics (best-effort — past-paper legacy topics have no chunks).
    const missedSyllabusIds = missed
      .map((r) => r.syllabus_topic_id)
      .filter((id): id is string => Boolean(id))
      .slice(0, 2);
    let remediation: Array<{
      syllabusTopicId: string;
      chunks: Array<{
        id: string;
        sectionTitle: string;
        sourcePage: number | null;
      }>;
    }> = [];
    try {
      remediation = await this.knowledge.retrieveForRemediation({
        syllabusTopicIds: missedSyllabusIds,
      });
    } catch {
      // reading citations are an enhancement, never a failure path
    }

    const topicById = new Map(
      named
        .filter((r) => r.syllabus_topic_id)
        .map((r) => [r.syllabus_topic_id as string, r.topic_title as string]),
    );
    const dataBlock = [
      `<data type="exam_answers">`,
      `Score: ${exam.percentScore ?? '?'}% (${exam.mode} exam).`,
      named.length
        ? `Per-topic results (weakest first):\n${named
            .map(
              (r) =>
                `- ${r.topic_title}: ${r.correct}/${r.answered} correct${r.syllabus_topic_id ? ` [topicId ${r.syllabus_topic_id}]` : ''}`,
            )
            .join('\n')}`
        : `No topic tags available for this exam's questions.`,
      mistakes.length
        ? `Wrong answers:\n${mistakes
            .map(
              (m) =>
                `- [${m.topic_title ?? 'unknown topic'}] "${m.stem}" — chose "${m.chosen ?? '—'}", correct was "${m.correct ?? '—'}"`,
            )
            .join('\n')}`
        : ``,
      remediation.length
        ? `Recommended reading (cite these EXACTLY when recommending):\n${remediation
            .flatMap((r) =>
              r.chunks.map(
                (c) =>
                  `- [chunkId ${c.id}] "${c.sectionTitle}"${c.sourcePage ? ` (p. ${c.sourcePage})` : ''} — for topic "${topicById.get(r.syllabusTopicId) ?? r.syllabusTopicId}"`,
              ),
            )
            .join('\n')}`
        : ``,
      `</data>`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const prompt = [
      dataBlock,
      ``,
      `Write the post-exam review JSON for this student: 4–6 sentences of`,
      `narrative naming what went well (up to two topics: ${strongest.map((s) => s.topic_title).join(', ') || 'none stood out'})`,
      `and what to fix (the weakest topics), grounded in the wrong answers`,
      `shown. Include 1–3 recommendations: "read" actions citing the`,
      `reading list where available, "practice" actions (count 5–15)`,
      `otherwise.`,
    ].join('\n');

    // `ai.fastModel` honors AI_DEFAULT_MODEL / AI_FAST_MODEL.
    const model =
      this.config.get<string>('ai.fastModel') ??
      'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
    const result = await this.ai.callBedrock(prompt, model, {
      maxTokens: 900,
      action: AiAction.POST_EXAM_BREAKDOWN,
      userId,
      system: SYSTEM_SHELL_POST_EXAM_BREAKDOWN,
      cacheSystemPrompt: true,
      promptVersion: POST_EXAM_BREAKDOWN_PROMPT_VERSION,
      prefill: '{"narrative":"',
    });

    const validation = validateNarrativeEnvelope(result.content, {
      requiredTitles: missed
        .map((r) => r.topic_title as string)
        .filter(Boolean)
        .slice(0, 4),
      validTopicIds: named
        .map((r) => r.syllabus_topic_id)
        .filter((id): id is string => Boolean(id)),
      validChunkIds: remediation.flatMap((r) => r.chunks.map((c) => c.id)),
    });
    if (!validation.ok) {
      this.logger.warn(
        `[post-exam] rejected exam=${examId} reason=${validation.reason} — ${validation.detail}`,
      );
      try {
        await this.rejectLog.record({
          jobId: null,
          action: 'post_exam_breakdown',
          provider: model.startsWith('ollama:') ? 'ollama' : 'bedrock',
          model,
          reason: validation.reason,
          detail: validation.detail,
          rawOutput: result.content,
        });
      } catch {
        /* best-effort */
      }
      throw new BadRequestException(
        'The AI breakdown came back malformed; try again in a moment.',
      );
    }

    exam.aiBreakdown = validation.value.narrative;
    exam.aiBreakdownRecommendations = validation.value.recommendations;
    exam.aiBreakdownModel = model;
    exam.aiBreakdownGeneratedAt = new Date();
    await this.examsRepo.save(exam);
    return {
      breakdown: validation.value.narrative,
      recommendations: validation.value.recommendations,
      generatedAt: exam.aiBreakdownGeneratedAt.toISOString(),
      model,
      cached: false,
    };
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

    // Load every existing progress row for the touched subjects in ONE
    // query (previous shape did N findOne calls — 4-subject exam = 4
    // round trips just to read). After in-memory merge, bulk-save: a
    // single transaction with one insert + one update per subject.
    const subjectIds = Array.from(bySubject.keys());
    if (subjectIds.length === 0) return;
    const existing = await this.progressRepo.find({
      where: subjectIds.map((subjectId) => ({ userId, subjectId })),
    });
    const byId = new Map(existing.map((p) => [p.subjectId, p]));

    const toSave = [];
    for (const [subjectId, bucket] of bySubject) {
      const progress =
        byId.get(subjectId) ?? this.progressRepo.create({ userId, subjectId });
      // CRITICAL: `repository.create()` does NOT apply column defaults
      // — `@Column({ default: 0 })` only kicks in at INSERT time on
      // the DB side. So a freshly-created row has questionsSeen /
      // questionsCorrect = undefined; `undefined += n` is NaN, which
      // Postgres rejects with `invalid input syntax for type integer:
      // "NaN"` when TypeORM serialises the row at save. Coerce
      // nullish → 0 before the increment so a brand-new subject row
      // inserts cleanly with the exam's contribution.
      progress.questionsSeen = (progress.questionsSeen ?? 0) + bucket.seen;
      progress.questionsCorrect =
        (progress.questionsCorrect ?? 0) + bucket.correct;
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
      toSave.push(progress);
    }
    // TypeORM batches the save into a single chunk-and-go round trip.
    await this.progressRepo.save(toSave, { chunk: 50 });
  }
}

/** Recorded on ai_usage_log.prompt_version. */
const POST_EXAM_BREAKDOWN_PROMPT_VERSION = 'postexam-v2';

/**
 * System shell for the post-exam AI review v2 (premium plan §6.5).
 * v1 ran with NO system turn at all — the only bare model call in the
 * codebase — and asked the model to guess topics from truncated stems.
 * v2 composes the shared student-facing blocks (injection guard, tone,
 * citation rule) and returns the JSON envelope the app renders as
 * narrative + tappable recommendations.
 */
const SYSTEM_SHELL_POST_EXAM_BREAKDOWN = [
  `You write short post-exam reviews for Ghanaian secondary-school
students preparing for WASSCE/BECE, based on one exam's per-topic
results and wrong answers.`,
  STUDENT_DATA_RULES,
  STUDENT_TONE_RULES,
  STUDENT_CITATION_RULES,
  `Narrative rules:
- 4–6 sentences of plain prose (no markdown, headings, or bullets).
- Name what went well (up to two topics) and what to fix (the weakest
  topics), using the wrong answers shown as concrete evidence.
- End the narrative by pointing at the FIRST recommendation ("Start
  with…") so prose and buttons agree.`,
  STUDENT_JSON_ENVELOPE,
].join('\n\n');
