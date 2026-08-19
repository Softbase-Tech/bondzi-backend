import { randomUUID } from 'crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { PmTestQuestion } from './entities/pm-test-question.entity';
import { PmTestOption } from './entities/pm-test-option.entity';
import { AiGenerationJob } from '../admin-ai-gen/entities/ai-generation-job.entity';
import { AiService } from '../ai/ai.service';
import { RedisService } from '../../common/redis/redis.service';
import { QUEUE_AI_GENERATION } from '../ai/ai.queues';
import {
  AiJobStatus,
  AiJobType,
  QuestionStatus,
} from '../../common/types/enums';
import {
  PmTestGenerateDto,
  PmTestPreviewDto,
  PmTestReviewBulkDto,
} from './dto/pm-test-generate.dto';
import {
  estimatePmTestJob,
  GenerationEstimate,
  resolveModelId,
} from '../admin-ai-gen/estimates.util';
import { validateQuestionBatch } from '../ai/validation/question.validator';

const PREVIEW_TTL_SECONDS = 10 * 60;
const MAX_TOTAL_QUESTIONS_PER_JOB = 100_000;

function previewKey(token: string): string {
  return `pm-test:preview:${token}`;
}

/**
 * Standard CSV escape — wrap in double quotes if the cell contains a
 * comma, double quote, or newline; double any embedded quotes. Applied
 * uniformly across every column so admins can round-trip an export
 * through Excel / Numbers without corrupting the rows.
 */
function csvCell(v: unknown): string {
  let s: string;
  if (v === null || v === undefined) s = '';
  else if (typeof v === 'string') s = v;
  else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
  else if (v instanceof Date) s = v.toISOString();
  else s = JSON.stringify(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export interface PmTestPreviewResult {
  confirmationToken: string;
  expiresAt: string;
  estimate: GenerationEstimate;
  perSelection: Array<{
    subjectId: string;
    formLevel: number;
    questionCount: number;
    estimatedCostUsd: number;
  }>;
  warnings: string[];
}

@Injectable()
export class AdminPmTestService {
  private readonly logger = new Logger(AdminPmTestService.name);

  constructor(
    @InjectRepository(PmTestQuestion)
    private readonly qRepo: Repository<PmTestQuestion>,
    @InjectRepository(PmTestOption)
    private readonly oRepo: Repository<PmTestOption>,
    @InjectRepository(AiGenerationJob)
    private readonly jobsRepo: Repository<AiGenerationJob>,
    @InjectQueue(QUEUE_AI_GENERATION)
    private readonly queue: Queue,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly ai: AiService,
  ) {}

  /** Spec §9.3: reject jobs whose estimated cost exceeds AI_MAX_JOB_COST_USD. */
  private assertUnderMaxCost(estimatedCostUsd: number): void {
    const cap =
      this.config.get<number>('ai.maxJobCostUsd') ??
      parseFloat(process.env.AI_MAX_JOB_COST_USD ?? '500');
    if (estimatedCostUsd > cap) {
      throw new BadRequestException(
        `Estimated job cost $${estimatedCostUsd.toFixed(2)} exceeds the per-job cap of $${cap.toFixed(2)}.`,
      );
    }
  }

  /**
   * Validate the request, compute estimates, stash params in Redis keyed by a
   * short-lived confirmation token. The admin calls `/generate` with the
   * token to actually trigger the job.
   */
  async preview(dto: PmTestPreviewDto): Promise<PmTestPreviewResult> {
    this.validatePreviewDto(dto);

    const totalQuestions = dto.selections.reduce(
      (n, s) => n + s.questionCount,
      0,
    );
    if (totalQuestions > MAX_TOTAL_QUESTIONS_PER_JOB) {
      throw new BadRequestException(
        `Total questions ${totalQuestions} exceeds the ${MAX_TOTAL_QUESTIONS_PER_JOB.toLocaleString()} per-job limit.`,
      );
    }

    const estimate = estimatePmTestJob(
      totalQuestions,
      dto.model,
      dto.batchSize,
    );
    this.assertUnderMaxCost(estimate.estimatedCostUsd);

    const perSelection = dto.selections.map((s) => {
      const e = estimatePmTestJob(s.questionCount, dto.model, dto.batchSize);
      return {
        subjectId: s.subjectId,
        formLevel: s.formLevel,
        questionCount: s.questionCount,
        estimatedCostUsd: e.estimatedCostUsd,
      };
    });

    const warnings: string[] = [];
    if (dto.selections.some((s) => s.mode === 'replace')) {
      warnings.push(
        'One or more selections use mode=replace — existing questions for that combo will be archived before new ones are inserted.',
      );
    }
    if (totalQuestions >= 10_000) {
      warnings.push(
        `Large job (${totalQuestions.toLocaleString()} questions). ETA ~${Math.round(estimate.estimatedSeconds / 60)} min.`,
      );
    }

    const confirmationToken = randomUUID();
    await this.redis.setJson(
      previewKey(confirmationToken),
      { dto, estimate },
      PREVIEW_TTL_SECONDS,
    );

    return {
      confirmationToken,
      expiresAt: new Date(
        Date.now() + PREVIEW_TTL_SECONDS * 1000,
      ).toISOString(),
      estimate,
      perSelection,
      warnings,
    };
  }

  async generate(
    adminId: string,
    dto: PmTestGenerateDto,
  ): Promise<AiGenerationJob> {
    const stashed = await this.redis.getJson<{
      dto: PmTestPreviewDto;
      estimate: GenerationEstimate;
    }>(previewKey(dto.confirmationToken));
    if (!stashed) {
      throw new BadRequestException(
        'Preview token expired or invalid — call /admin/pm-test/preview again.',
      );
    }

    // Drop the token so it can't be reused.
    await this.redis.del(previewKey(dto.confirmationToken));

    // Row-count backstop. AI_MAX_JOB_COST_USD (see assertUnderMaxCost)
    // is a $-cap and does nothing on the Ollama path (local calls are
    // $0); this row-count cap is what protects prod from a mistyped
    // batch on either provider.
    this.ai.assertBatchWithinCap(stashed.estimate.totalItems);

    const job = this.jobsRepo.create({
      jobType: AiJobType.PM_TEST_GENERATION,
      status: AiJobStatus.PENDING,
      triggeredBy: adminId,
      parameters: stashed.dto as unknown as Record<string, unknown>,
      totalItems: stashed.estimate.totalItems,
      estimatedCostUsd: stashed.estimate.estimatedCostUsd.toFixed(4),
      modelUsed: resolveModelId(stashed.dto.model),
    });
    await this.jobsRepo.save(job);

    await this.queue.add(
      'pm-test-generation',
      { jobId: job.id },
      // See AdminExplanationsService for the rationale — same backoff
      // + cleanup contract.
      {
        removeOnComplete: { age: 24 * 3600, count: 200 },
        removeOnFail: { age: 7 * 24 * 3600, count: 100 },
        attempts: 2,
        backoff: { type: 'exponential', delay: 30_000 },
      },
    );

    return job;
  }

  listJobs(): Promise<AiGenerationJob[]> {
    return this.jobsRepo.find({
      where: { jobType: AiJobType.PM_TEST_GENERATION },
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }

  async getJob(id: string): Promise<AiGenerationJob> {
    const job = await this.jobsRepo.findOne({ where: { id } });
    if (!job || job.jobType !== AiJobType.PM_TEST_GENERATION) {
      throw new NotFoundException('Job not found');
    }
    return job;
  }

  async listReview(params: {
    examType?: string;
    formLevel?: number;
    subjectId?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));

    const qb = this.qRepo
      .createQueryBuilder('q')
      .leftJoinAndSelect('q.options', 'o')
      .where('q.status = :st', { st: QuestionStatus.PENDING_REVIEW });
    if (params.examType)
      qb.andWhere('q.exam_type = :et', { et: params.examType });
    if (params.formLevel !== undefined)
      qb.andWhere('q.form_level = :fl', { fl: params.formLevel });
    if (params.subjectId)
      qb.andWhere('q.subject_id = :sid', { sid: params.subjectId });

    // orderBy must reference the entity *property* name (createdAt), not the
    // DB column (created_at). With leftJoinAndSelect in play, TypeORM's
    // distinct-pagination path resolves the orderBy through entity metadata
    // and crashes ("Cannot read properties of undefined (reading
    // 'databaseName')") if the name doesn't match a property.
    qb.orderBy('q.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();
    return { items, total, nextCursor: null };
  }

  /**
   * General-purpose browse over the pm_test_questions bank. Powers the
   * "Level Test (AI)" source on /admin/questions so ops can filter and
   * inspect Level Test items the same way they filter past-paper
   * questions — instead of forcing them through the review queue,
   * which only shows pending items.
   *
   * Status filter: omitted → all statuses; otherwise one of
   * `pending_review` | `active` | `archived`. Search runs against
   * body/explanation (ILIKE — the pm_test_questions table has no GIN
   * index and the corpus is small enough that this is fine).
   */
  async listAll(params: {
    examType?: string;
    formLevel?: number;
    subjectId?: string;
    difficulty?: string;
    status?: string;
    search?: string;
    batchId?: string;
    hasExplanation?: boolean;
    createdFrom?: string;
    createdTo?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));

    const qb = this.buildListQuery(params);
    qb.orderBy('q.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();
    return { items, total, nextCursor: null };
  }

  /**
   * Shared filter builder used by `listAll` and `exportCsv`. Kept
   * private so the two callers can't drift out of sync — an export
   * that filters differently from the list would ship rows the
   * reviewer never actually saw.
   */
  private buildListQuery(params: {
    examType?: string;
    formLevel?: number;
    subjectId?: string;
    difficulty?: string;
    status?: string;
    search?: string;
    batchId?: string;
    hasExplanation?: boolean;
    createdFrom?: string;
    createdTo?: string;
  }) {
    const qb = this.qRepo
      .createQueryBuilder('q')
      .leftJoinAndSelect('q.options', 'o')
      .leftJoinAndSelect('q.subject', 's');

    if (params.status) qb.andWhere('q.status = :st', { st: params.status });
    if (params.examType)
      qb.andWhere('q.exam_type = :et', { et: params.examType });
    if (params.formLevel !== undefined)
      qb.andWhere('q.form_level = :fl', { fl: params.formLevel });
    if (params.subjectId)
      qb.andWhere('q.subject_id = :sid', { sid: params.subjectId });
    if (params.difficulty)
      qb.andWhere('q.difficulty = :d', { d: params.difficulty });
    if (params.batchId)
      qb.andWhere('q.generation_batch_id = :b', { b: params.batchId });
    if (params.hasExplanation === true)
      qb.andWhere("coalesce(q.explanation, '') <> ''");
    if (params.hasExplanation === false)
      qb.andWhere("coalesce(q.explanation, '') = ''");
    if (params.createdFrom)
      qb.andWhere('q.created_at >= :cf', { cf: params.createdFrom });
    if (params.createdTo)
      qb.andWhere('q.created_at <= :ct', { ct: params.createdTo });
    if (params.search && params.search.trim()) {
      const needle = `%${params.search.trim()}%`;
      qb.andWhere('(q.body ILIKE :n OR q.explanation ILIKE :n)', { n: needle });
    }

    return qb;
  }

  /**
   * Fetch one full question with options + subject + syllabus topic
   * relation loaded. Powers the admin Level-Test detail screen.
   */
  async getOne(id: string): Promise<PmTestQuestion> {
    const row = await this.qRepo.findOne({
      where: { id },
      relations: ['options', 'subject', 'syllabusTopic'],
    });
    if (!row) throw new NotFoundException('PM Test question not found');
    return row;
  }

  /**
   * Surgical PATCH — replace only the fields the admin sent. The
   * options array is all-or-nothing: if provided, must be exactly 4
   * with exactly one isCorrect. Rejecting the whole payload on
   * option-shape violation keeps the invariant that every row in
   * pm_test_questions has a valid answer key.
   */
  async updateOne(
    id: string,
    dto: {
      body?: string;
      explanation?: string;
      difficulty?: 'easy' | 'medium' | 'hard';
      syllabusTopicId?: string | null;
      options?: Array<{ label: string; body: string; isCorrect: boolean }>;
    },
  ): Promise<PmTestQuestion> {
    const row = await this.qRepo.findOne({
      where: { id },
      relations: ['options'],
    });
    if (!row) throw new NotFoundException('PM Test question not found');

    if (dto.options) {
      const correctCount = dto.options.filter((o) => o.isCorrect).length;
      if (correctCount !== 1) {
        throw new BadRequestException(
          `options must contain exactly one isCorrect=true (got ${correctCount})`,
        );
      }
      const labels = new Set(dto.options.map((o) => o.label.trim()));
      if (labels.size !== 4) {
        throw new BadRequestException('options must have four unique labels');
      }
      const bodies = new Set(
        dto.options.map((o) => o.body.trim().toLowerCase()),
      );
      if (bodies.size !== 4) {
        throw new BadRequestException(
          'options must have four unique bodies (case-insensitive)',
        );
      }
    }

    if (dto.body !== undefined) row.body = dto.body;
    if (dto.explanation !== undefined) row.explanation = dto.explanation;
    if (dto.difficulty !== undefined) {
      // The QuestionStatus vs Difficulty enums both live on the row —
      // keep the cast tight so a typo doesn't silently store 'medum'.
      row.difficulty = dto.difficulty as PmTestQuestion['difficulty'];
    }
    if (dto.syllabusTopicId !== undefined)
      row.syllabusTopicId = dto.syllabusTopicId;
    await this.qRepo.save(row);

    if (dto.options) {
      // Replace the option set. Delete-then-insert is simpler and
      // correct — labels are stable within a question, and the option
      // FK cascade fires as expected.
      await this.oRepo.delete({ questionId: row.id });
      const fresh = dto.options.map((o) =>
        this.oRepo.create({
          questionId: row.id,
          label: o.label.trim(),
          body: o.body.trim(),
          isCorrect: o.isCorrect,
        }),
      );
      await this.oRepo.save(fresh);
    }

    return this.getOne(id);
  }

  /**
   * Bulk import path for CSV / JSONL uploads. Each item goes through
   * the same wire-level validation as AI-generated batches so admin
   * uploads can't slip past the meta-syllabus / stem-leak / all-of-
   * the-above checks either.
   *
   * Rows default to `pending_review` unless the admin explicitly
   * opts into `publishImmediately`. Rejected rows are returned in
   * the response — nothing partially applies within a row (options
   * insert only after the parent question insert succeeds).
   */
  async bulkImport(dto: {
    items: Array<{
      subjectId: string;
      formLevel: number;
      examType: string;
      difficulty: 'easy' | 'medium' | 'hard';
      body: string;
      explanation?: string;
      syllabusTopicId?: string;
      options: Array<{ label: string; body: string; isCorrect: boolean }>;
    }>;
    publishImmediately?: boolean;
  }): Promise<{
    inserted: number;
    rejected: Array<{ index: number; reason: string; detail: string }>;
    ids: string[];
  }> {
    const rejected: Array<{ index: number; reason: string; detail: string }> =
      [];
    const ids: string[] = [];
    const status = dto.publishImmediately
      ? QuestionStatus.ACTIVE
      : QuestionStatus.PENDING_REVIEW;

    for (let i = 0; i < dto.items.length; i++) {
      const item = dto.items[i];

      // Same wire-level validation used against AI-generated rows so
      // an admin upload can't sneak a meta-syllabus stem past the gate.
      const asBatch = JSON.stringify([
        {
          body: item.body,
          difficulty: item.difficulty,
          options: item.options,
          explanation: item.explanation ?? '',
        },
      ]);
      const val = validateQuestionBatch(asBatch);
      if (!val.ok) {
        rejected.push({
          index: i,
          reason: val.reason,
          detail: val.detail,
        });
        continue;
      }

      try {
        const row = this.qRepo.create({
          subjectId: item.subjectId,
          examType: item.examType as PmTestQuestion['examType'],
          formLevel: item.formLevel,
          body: item.body.trim(),
          difficulty: item.difficulty as PmTestQuestion['difficulty'],
          explanation: item.explanation?.trim() || null,
          syllabusTopicId: item.syllabusTopicId ?? null,
          status,
          generationBatchId: null,
        });
        await this.qRepo.save(row);
        const opts = item.options.map((o) =>
          this.oRepo.create({
            questionId: row.id,
            label: o.label.trim(),
            body: o.body.trim(),
            isCorrect: o.isCorrect,
          }),
        );
        await this.oRepo.save(opts);
        ids.push(row.id);
      } catch (err) {
        rejected.push({
          index: i,
          reason: 'db_insert_failed',
          detail: (err as Error).message,
        });
      }
    }

    return { inserted: ids.length, rejected, ids };
  }

  /**
   * Server-side CSV export. Reuses the exact filter shape so the
   * download matches the on-screen list. Streams into memory (not a
   * response stream) because the cap here is small — max 5000 rows
   * is the sensible admin-workflow bound, well under the memory
   * ceiling and small enough to send as a single response.
   */
  async exportCsv(
    params: Parameters<AdminPmTestService['listAll']>[0],
  ): Promise<string> {
    const qb = this.buildListQuery(params);
    qb.orderBy('q.createdAt', 'DESC').take(5000);
    const rows = await qb.getMany();

    const header = [
      'id',
      'subject',
      'exam_type',
      'form_level',
      'difficulty',
      'status',
      'batch_id',
      'body',
      'option_a',
      'option_b',
      'option_c',
      'option_d',
      'correct_letter',
      'explanation',
      'times_answered',
      'times_correct',
      'created_at',
    ];

    const csvRows: string[] = [header.map(csvCell).join(',')];
    for (const q of rows) {
      const opts = [...(q.options ?? [])].sort((a, b) =>
        a.label.localeCompare(b.label),
      );
      const findOpt = (l: string) =>
        opts.find((o) => o.label === l)?.body ?? '';
      const correctLetter = opts.find((o) => o.isCorrect)?.label ?? '';
      csvRows.push(
        [
          q.id,
          q.subject?.name ?? '',
          q.examType,
          q.formLevel,
          q.difficulty,
          q.status,
          q.generationBatchId ?? '',
          q.body,
          findOpt('A'),
          findOpt('B'),
          findOpt('C'),
          findOpt('D'),
          correctLetter,
          q.explanation ?? '',
          q.timesAnswered,
          q.timesCorrect,
          q.createdAt.toISOString(),
        ]
          .map(csvCell)
          .join(','),
      );
    }

    return csvRows.join('\n');
  }

  async bulkReview(dto: PmTestReviewBulkDto) {
    const results: Array<{ id: string; action: string; ok: boolean }> = [];
    for (const item of dto.items) {
      try {
        const row = await this.qRepo.findOne({ where: { id: item.id } });
        if (!row) {
          results.push({ id: item.id, action: item.action, ok: false });
          continue;
        }
        if (item.action === 'approve') {
          row.status = QuestionStatus.ACTIVE;
        } else if (item.action === 'reject') {
          row.status = QuestionStatus.ARCHIVED;
        } else {
          if (item.body !== undefined) row.body = item.body;
          if (item.explanation !== undefined)
            row.explanation = item.explanation;
        }
        await this.qRepo.save(row);
        results.push({ id: item.id, action: item.action, ok: true });
      } catch (err) {
        this.logger.warn(
          `bulkReview ${item.id} failed: ${(err as Error).message}`,
        );
        results.push({ id: item.id, action: item.action, ok: false });
      }
    }
    return { results };
  }

  async publish(id: string): Promise<PmTestQuestion> {
    const row = await this.qRepo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Question not found');
    row.status = QuestionStatus.ACTIVE;
    return this.qRepo.save(row);
  }

  async archive(id: string): Promise<PmTestQuestion> {
    const row = await this.qRepo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Question not found');
    row.status = QuestionStatus.ARCHIVED;
    return this.qRepo.save(row);
  }

  private validatePreviewDto(dto: PmTestPreviewDto): void {
    for (const s of dto.selections) {
      const sum = s.difficulty.easy + s.difficulty.medium + s.difficulty.hard;
      if (sum !== 100) {
        throw new BadRequestException(
          `Difficulty mix for selection (subject ${s.subjectId}, form ${s.formLevel}) sums to ${sum}% — must be 100%.`,
        );
      }
    }
  }
}
