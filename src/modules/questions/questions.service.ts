import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Question } from './entities/question.entity';
import { Option } from './entities/option.entity';
import { QuestionFlag } from './entities/question-flag.entity';
import { SrsCard } from '../srs/entities/srs-card.entity';
import { UserSubjectProgress } from '../progress/entities/user-subject-progress.entity';
import { RedisService } from '../../common/redis/redis.service';
import { CacheKeys } from '../../common/utils/cache-keys.util';
import { sanitizeHtml } from '../../common/utils/sanitize.util';
import { markdownToHtml } from '../../common/utils/math.util';
import {
  AdminQuestion,
  StudentQuestion,
  toAdminQuestion,
  toStudentQuestion,
} from './serializers/question.serializer';
import { QuestionQueryDto } from './dto/question-query.dto';
import { PastPaperQueryDto, AdaptiveQueryDto } from './dto/past-paper.dto';
import {
  BulkImportDto,
  CreateQuestionDto,
  UpdateQuestionDto,
} from './dto/create-question.dto';
import { FlagQuestionDto } from './dto/flag-question.dto';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { StimuliService } from './stimuli.service';

const PAST_PAPER_TTL_SECONDS = 24 * 60 * 60;

@Injectable()
export class QuestionsService {
  constructor(
    @InjectRepository(Question)
    private readonly questionsRepo: Repository<Question>,
    @InjectRepository(Option) private readonly optionsRepo: Repository<Option>,
    @InjectRepository(QuestionFlag)
    private readonly flagsRepo: Repository<QuestionFlag>,
    @InjectRepository(SrsCard) private readonly srsRepo: Repository<SrsCard>,
    @InjectRepository(UserSubjectProgress)
    private readonly progressRepo: Repository<UserSubjectProgress>,
    private readonly redis: RedisService,
    private readonly dataSource: DataSource,
    private readonly stimuli: StimuliService,
  ) {}

  async list(
    query: QuestionQueryDto,
    opts: {
      isAdmin: boolean;
      hasActiveSubscription: boolean;
      defaultExamType?: string;
    },
  ): Promise<PaginatedResult<StudentQuestion | AdminQuestion>> {
    const qb = this.questionsRepo
      .createQueryBuilder('q')
      .leftJoinAndSelect('q.options', 'o')
      .leftJoinAndSelect('q.stimulus', 'stim')
      .orderBy('q.createdAt', 'DESC');

    if (!opts.isAdmin) qb.andWhere("q.status = 'active'");

    // v2 spec §3.1: examType is MANDATORY — BECE and WASSCE must never mix in
    // a single response. Admins may explicitly ask for either; non-admins
    // fall through to their JWT examType.

    const examType = query.examType ?? opts.defaultExamType;
    if (!examType) {
      throw new BadRequestException('examType is required on this endpoint.');
    }

    qb.andWhere('q.exam_type = :et', { et: examType });

    if (query.subjectId)
      qb.andWhere('q.subjectId = :sid', { sid: query.subjectId });
    if (query.topicId) qb.andWhere('q.topicId = :tid', { tid: query.topicId });
    if (query.year) qb.andWhere('q.year = :year', { year: query.year });
    if (query.difficulty)
      qb.andWhere('q.difficulty = :difficulty', {
        difficulty: query.difficulty,
      });
    if (query.source)
      qb.andWhere('q.source = :source', { source: query.source });
    if (query.isVerified !== undefined)
      qb.andWhere('q.isVerified = :iv', { iv: query.isVerified });
    if (query.search) {
      qb.andWhere(
        `to_tsvector('english', q.body) @@ plainto_tsquery('english', :search)`,
        {
          search: query.search,
        },
      );
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    qb.skip((page - 1) * limit).take(limit);

    const [items, total] = await qb.getManyAndCount();
    const serializerOpts = {
      hasActiveSubscription: opts.hasActiveSubscription,
    };
    return {
      items: opts.isAdmin
        ? items.map(toAdminQuestion)
        : items.map((q) => toStudentQuestion(q, serializerOpts)),
      total,
      nextCursor: null,
    };
  }

  async search(
    q: string,
    opts: { hasActiveSubscription: boolean },
    limit = 20,
  ): Promise<StudentQuestion[]> {
    if (!q?.trim()) return [];
    const rows = await this.questionsRepo
      .createQueryBuilder('q')
      .leftJoinAndSelect('q.options', 'o')
      .leftJoinAndSelect('q.stimulus', 'stim')
      .where("q.status = 'active'")
      .andWhere(
        `to_tsvector('english', q.body) @@ plainto_tsquery('english', :search)`,
        { search: q },
      )
      .orderBy(
        `ts_rank(to_tsvector('english', q.body), plainto_tsquery('english', :search))`,
        'DESC',
      )
      .setParameters({ search: q })
      .limit(limit)
      .getMany();
    return rows.map((row) => toStudentQuestion(row, opts));
  }

  async years(subjectId: string): Promise<number[]> {
    const rows = await this.questionsRepo
      .createQueryBuilder('q')
      .select('DISTINCT q.year', 'year')
      .where('q.subjectId = :sid', { sid: subjectId })
      .andWhere('q.year IS NOT NULL')
      .andWhere("q.status = 'active'")
      .orderBy('q.year', 'DESC')
      .getRawMany<{ year: number }>();
    return rows.map((r) => r.year).filter((y): y is number => y !== null);
  }

  async getById(
    id: string,
    opts: { isAdmin: boolean; hasActiveSubscription: boolean },
  ): Promise<StudentQuestion | AdminQuestion> {
    const question = await this.questionsRepo.findOne({
      where: { id },
      relations: ['options', 'stimulus'],
    });
    if (!question) throw new NotFoundException('Question not found');
    return opts.isAdmin
      ? toAdminQuestion(question)
      : toStudentQuestion(question, {
          hasActiveSubscription: opts.hasActiveSubscription,
        });
  }

  /**
   * Past-paper results are cached *without* inline explanations — the
   * serializer never gates via cache since the same cache is shared across
   * subscribed + free users. We always cache with `hasExplanation` set and
   * `explanation: null`, then overlay the subscriber-only explanation after
   * reading.
   */
  async getPastPaper(
    query: PastPaperQueryDto,
    opts: { hasActiveSubscription: boolean; examType: string },
  ): Promise<StudentQuestion[]> {
    const cacheKey = CacheKeys.pastPaper(
      opts.examType,
      query.subjectId,
      query.year,
      query.paper,
    );
    const cached = await this.redis.getJson<StudentQuestion[]>(cacheKey);
    if (cached) {
      return opts.hasActiveSubscription
        ? this.hydrateExplanations(cached)
        : cached;
    }

    const qb = this.questionsRepo
      .createQueryBuilder('q')
      .leftJoinAndSelect('q.options', 'o')
      .leftJoinAndSelect('q.stimulus', 'stim')
      .where('q.subjectId = :sid', { sid: query.subjectId })
      .andWhere('q.year = :year', { year: query.year })
      .andWhere('q.exam_type = :et', { et: opts.examType })
      .andWhere("q.status = 'active'");

    if (query.paper !== undefined)
      qb.andWhere('q.wassecPaper = :paper', { paper: query.paper });
    qb.orderBy('q.wassecPaper', 'ASC')
      .addOrderBy('q.section', 'ASC')
      .addOrderBy('q.createdAt', 'ASC');

    const rows = await qb.getMany();
    // Cache the free shape (no explanation).
    const free = rows.map((q) =>
      toStudentQuestion(q, { hasActiveSubscription: false }),
    );
    await this.redis.setJson(cacheKey, free, PAST_PAPER_TTL_SECONDS);
    return opts.hasActiveSubscription
      ? rows.map((q) => toStudentQuestion(q, { hasActiveSubscription: true }))
      : free;
  }

  /**
   * For cached past-paper rows, fetch the inline explanations in bulk and
   * merge them in. Runs only for subscribed users.
   */
  private async hydrateExplanations(
    serialised: StudentQuestion[],
  ): Promise<StudentQuestion[]> {
    const ids = serialised.filter((s) => s.hasExplanation).map((s) => s.id);
    if (ids.length === 0) return serialised;
    const rows = await this.questionsRepo.find({
      where: ids.map((id) => ({ id })),
      select: ['id', 'explanation', 'explanationHtml'],
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return serialised.map((s) => {
      const r = byId.get(s.id);
      if (!r) return s;
      return {
        ...s,
        explanation: r.explanation,
        explanationHtml: r.explanationHtml,
      };
    });
  }

  /**
   * Adaptive question fetch (spec §5.4).
   * 1. Fill from due SRS cards for this user+subject.
   * 2. Then target the user's worst-performing topics.
   * 3. Pad remaining with random active questions in the subject.
   * Excludes questions answered in the last 24h.
   */
  async getAdaptive(
    userId: string,
    query: AdaptiveQueryDto,
    opts: { hasActiveSubscription: boolean },
  ): Promise<StudentQuestion[]> {
    const count = query.count ?? 20;

    // Spec §3.1: adaptive results are always scoped by the caller's exam_type
    // from the JWT. Fetch once and apply to every step's WHERE clause.
    const user = await this.dataSource
      .getRepository('users')
      .createQueryBuilder('u')
      .select('u.exam_type', 'examType')
      .where('u.id = :uid', { uid: userId })
      .getRawOne<{ examType: string }>();
    const examType = user?.examType;

    const recentIds = await this.dataSource.query<
      Array<{ question_id: string }>
    >(
      `select distinct ea.question_id
         from exam_answers ea
         inner join exams e on e.id = ea.exam_id
         where e.user_id = $1 and ea.answered_at > now() - interval '24 hours'`,
      [userId],
    );
    const excludeIds = recentIds.map((r) => r.question_id);

    // Step 1: due SRS cards in this subject.
    const dueSrs = await this.srsRepo
      .createQueryBuilder('sc')
      .innerJoin('sc.question', 'q')
      .select('sc.question_id', 'questionId')
      .where('sc.user_id = :userId', { userId })
      .andWhere('sc.next_review_at <= now()')
      .andWhere('q.subject_id = :sid', { sid: query.subjectId })
      .andWhere("q.status = 'active'")
      .andWhere(examType ? 'q.exam_type = :et' : '1=1', { et: examType })
      .limit(count * 2)
      .getRawMany<{ questionId: string }>();

    const picked = new Set<string>();
    for (const row of dueSrs) picked.add(row.questionId);

    // Step 2: worst-performing topics for this user in this subject.
    if (picked.size < count) {
      const progress = await this.progressRepo.findOne({
        where: { userId, subjectId: query.subjectId },
      });
      const weakTopics: string[] = [];
      if (progress?.topicAccuracy) {
        weakTopics.push(
          ...Object.entries(progress.topicAccuracy)
            .filter(([, v]) => v.seen >= 3)
            .sort((a, b) => a[1].correct / a[1].seen - b[1].correct / b[1].seen)
            .slice(0, 5)
            .map(([tid]) => tid),
        );
      }
      if (weakTopics.length > 0) {
        const rows = await this.questionsRepo
          .createQueryBuilder('q')
          .select('q.id', 'id')
          .where('q.subject_id = :sid', { sid: query.subjectId })
          .andWhere('q.topic_id IN (:...topics)', { topics: weakTopics })
          .andWhere("q.status = 'active'")
          .andWhere(examType ? 'q.exam_type = :et' : '1=1', { et: examType })
          .andWhere(excludeIds.length > 0 ? 'q.id NOT IN (:...ex)' : '1=1', {
            ex: excludeIds.length ? excludeIds : [''],
          })
          .orderBy('random()')
          .limit((count - picked.size) * 2)
          .getRawMany<{ id: string }>();
        for (const row of rows) {
          if (picked.size >= count) break;
          picked.add(row.id);
        }
      }
    }

    // Step 3: random fill.
    if (picked.size < count) {
      const remaining = count - picked.size;
      const existing = [...picked, ...excludeIds];
      const rows = await this.questionsRepo
        .createQueryBuilder('q')
        .select('q.id', 'id')
        .where('q.subject_id = :sid', { sid: query.subjectId })
        .andWhere("q.status = 'active'")
        .andWhere(examType ? 'q.exam_type = :et' : '1=1', { et: examType })
        .andWhere(existing.length > 0 ? 'q.id NOT IN (:...ex)' : '1=1', {
          ex: existing.length ? existing : [''],
        })
        .orderBy('random()')
        .limit(remaining)
        .getRawMany<{ id: string }>();
      for (const row of rows) picked.add(row.id);
    }

    if (picked.size === 0) return [];
    const ids = [...picked];
    const questions = await this.questionsRepo.find({
      where: ids.map((id) => ({ id })),
      relations: ['options', 'stimulus'],
    });
    // preserve original order (SRS first, then weak-topic, then random)
    const idIndex = new Map(ids.map((id, i) => [id, i] as const));
    questions.sort(
      (a, b) => (idIndex.get(a.id) ?? 0) - (idIndex.get(b.id) ?? 0),
    );
    return questions.map((q) => toStudentQuestion(q, opts));
  }

  async create(dto: CreateQuestionDto): Promise<Question> {
    this.validateOptionsExactlyOneCorrect(dto.options);
    if (dto.stimulusId) {
      await this.stimuli.assertExists(dto.stimulusId);
    }

    return this.dataSource.transaction(async (em) => {
      const qRepo = em.getRepository(Question);
      const oRepo = em.getRepository(Option);
      const question = qRepo.create({
        subjectId: dto.subjectId,
        topicId: dto.topicId ?? null,
        stimulusId: dto.stimulusId ?? null,
        examType: dto.examType,
        questionType: dto.questionType,
        source: dto.source,
        body: dto.body,
        bodyHtml: sanitizeHtml(markdownToHtml(dto.body)),
        imageUrl: dto.imageUrl ?? null,
        year: dto.year ?? null,
        wassecPaper: dto.wassecPaper ?? null,
        section: dto.section ?? null,
        difficulty: dto.difficulty,
        tags: dto.tags ?? [],
      });
      await qRepo.save(question);

      const options = dto.options.map((o, idx) =>
        oRepo.create({
          questionId: question.id,
          label: o.label,
          body: o.body,
          bodyHtml: sanitizeHtml(markdownToHtml(o.body)),
          imageUrl: o.imageUrl ?? null,
          isCorrect: o.isCorrect,
          sortOrder: o.sortOrder ?? idx,
        }),
      );
      await oRepo.save(options);
      question.options = options;
      await this.invalidatePastPaperCache(
        question.subjectId,
        question.year ?? undefined,
        question.examType,
      );
      return question;
    });
  }

  async update(id: string, dto: UpdateQuestionDto): Promise<Question> {
    const question = await this.questionsRepo.findOne({
      where: { id },
      relations: ['options', 'stimulus'],
    });
    if (!question) throw new NotFoundException('Question not found');

    // If options are included, validate and replace the set atomically.
    if (dto.options) {
      this.validateOptionsExactlyOneCorrect(dto.options);
    }
    // stimulusId is tri-state: undefined (no change), null (detach), uuid
    // (attach). Validate the attach case before we touch the row.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const nextStimulusId = dto.stimulusId;
    if (typeof nextStimulusId === 'string') {
      await this.stimuli.assertExists(nextStimulusId);
    }

    const { options, ...scalars } = dto;
    Object.assign(question, scalars);
    if (dto.body) question.bodyHtml = sanitizeHtml(markdownToHtml(dto.body));

    await this.dataSource.transaction(async (tx) => {
      await tx.getRepository(Question).save(question);
      if (options) {
        await tx.getRepository(Option).delete({ questionId: question.id });
        const fresh = options.map((o, i) =>
          tx.getRepository(Option).create({
            questionId: question.id,
            label: o.label,
            body: o.body,
            // Bug fix: prior to this, an option update wrote `body` but left
            // `body_html` stale (or null). Mobile/admin then rendered the old
            // HTML for new option text — particularly painful with math.
            bodyHtml: sanitizeHtml(markdownToHtml(o.body)),
            imageUrl: o.imageUrl ?? null,
            isCorrect: o.isCorrect,
            sortOrder: o.sortOrder ?? i,
          }),
        );
        await tx.getRepository(Option).save(fresh);
      }
    });

    await this.invalidatePastPaperCache(
      question.subjectId,
      question.year ?? undefined,
      question.examType,
    );

    // Reload with the fresh option set.
    return (await this.questionsRepo.findOne({
      where: { id },
      relations: ['options', 'stimulus'],
    }))!;
  }

  async bulkImport(dto: BulkImportDto): Promise<{
    created: number;
    errors: Array<{ index: number; message: string }>;
  }> {
    const errors: Array<{ index: number; message: string }> = [];
    dto.questions.forEach((q, i) => {
      try {
        this.validateOptionsExactlyOneCorrect(q.options);
      } catch (err) {
        errors.push({ index: i, message: (err as Error).message });
      }
    });
    if (errors.length > 0) return { created: 0, errors };

    // Validate every distinct stimulus reference up-front so a bad FK doesn't
    // roll back partial work mid-transaction.
    const stimulusIds = Array.from(
      new Set(
        dto.questions
          .map((q) => q.stimulusId)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    for (const sid of stimulusIds) {
      await this.stimuli.assertExists(sid);
    }

    let created = 0;
    await this.dataSource.transaction(async (em) => {
      const qRepo = em.getRepository(Question);
      const oRepo = em.getRepository(Option);
      for (const q of dto.questions) {
        const question = qRepo.create({
          subjectId: q.subjectId,
          topicId: q.topicId ?? null,
          stimulusId: q.stimulusId ?? null,
          examType: q.examType,
          questionType: q.questionType,
          source: q.source,
          body: q.body,
          bodyHtml: sanitizeHtml(markdownToHtml(q.body)),
          imageUrl: q.imageUrl ?? null,
          year: q.year ?? null,
          wassecPaper: q.wassecPaper ?? null,
          section: q.section ?? null,
          difficulty: q.difficulty,
          tags: q.tags ?? [],
        });
        await qRepo.save(question);
        const options = q.options.map((o, idx) =>
          oRepo.create({
            questionId: question.id,
            label: o.label,
            body: o.body,
            bodyHtml: sanitizeHtml(markdownToHtml(o.body)),
            imageUrl: o.imageUrl ?? null,
            isCorrect: o.isCorrect,
            sortOrder: o.sortOrder ?? idx,
          }),
        );
        await oRepo.save(options);
        created++;
      }
    });
    return { created, errors };
  }

  async flag(
    userId: string,
    questionId: string,
    dto: FlagQuestionDto,
  ): Promise<QuestionFlag> {
    const question = await this.questionsRepo.findOne({
      where: { id: questionId },
    });
    if (!question) throw new NotFoundException('Question not found');

    return this.dataSource.transaction(async (em) => {
      const flag = em.getRepository(QuestionFlag).create({
        questionId,
        userId,
        reason: dto.reason,
        note: dto.note ?? null,
      });
      await em.getRepository(QuestionFlag).insert(flag);
      await em
        .getRepository(Question)
        .createQueryBuilder()
        .update(Question)
        .set({ flagCount: () => '"flag_count" + 1' })
        .where('id = :id', { id: questionId })
        .execute();
      return flag;
    });
  }

  async verify(id: string): Promise<Question> {
    const question = await this.questionsRepo.findOne({ where: { id } });
    if (!question) throw new NotFoundException('Question not found');
    question.isVerified = true;
    await this.questionsRepo.save(question);
    return question;
  }

  private validateOptionsExactlyOneCorrect(
    options: Array<{ isCorrect: boolean }>,
  ): void {
    const correctCount = options.filter((o) => o.isCorrect).length;
    if (correctCount === 0)
      throw new BadRequestException('At least one option must be correct');
    if (correctCount > 1)
      throw new ConflictException(
        'Only one option may be marked correct for MCQ',
      );
  }

  private async invalidatePastPaperCache(
    subjectId: string,
    year?: number,
    examType?: string,
  ): Promise<void> {
    if (!year) return;
    // The cache key now includes examType; when we don't know which, evict
    // both possible variants so neither platform holds stale data.
    const examTypes = examType ? [examType] : ['bece', 'wassce'];
    const keys: string[] = [];
    for (const et of examTypes) {
      for (const paper of [1, 2] as const) {
        keys.push(CacheKeys.pastPaper(et, subjectId, year, paper));
      }
      keys.push(CacheKeys.pastPaper(et, subjectId, year, undefined));
    }
    await this.redis.del(keys);
  }
}
