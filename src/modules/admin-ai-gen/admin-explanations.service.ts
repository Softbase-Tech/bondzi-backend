import { randomUUID } from 'crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type MessageEvent,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Observable } from 'rxjs';
import { Between, IsNull, Not, Repository } from 'typeorm';
import { AiGenerationJob } from './entities/ai-generation-job.entity';
import { Question } from '../questions/entities/question.entity';
import { RedisService } from '../../common/redis/redis.service';
import { QUEUE_AI_GENERATION } from '../ai/ai.queues';
import { AiJobStatus, AiJobType, ExamType } from '../../common/types/enums';
import {
  ExplanationFiltersDto,
  ExplanationGenerateDto,
  ExplanationPreviewDto,
} from './dto/explanation-generate.dto';
import {
  estimateExplanationJob,
  GenerationEstimate,
  resolveModelId,
} from './estimates.util';

const PREVIEW_TTL_SECONDS = 10 * 60;

function previewKey(token: string): string {
  return `explanation:preview:${token}`;
}

export interface ExplanationPreviewResult {
  confirmationToken: string;
  expiresAt: string;
  matchingQuestions: number;
  estimate: GenerationEstimate;
  sample: Array<{ id: string; body: string }>;
}

@Injectable()
export class AdminExplanationsService {
  private readonly logger = new Logger(AdminExplanationsService.name);

  constructor(
    @InjectRepository(Question)
    private readonly questionsRepo: Repository<Question>,
    @InjectRepository(AiGenerationJob)
    private readonly jobsRepo: Repository<AiGenerationJob>,
    @InjectQueue(QUEUE_AI_GENERATION)
    private readonly queue: Queue,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  /** Spec §9.3: reject jobs whose estimated cost exceeds AI_MAX_JOB_COST_USD. */
  private assertUnderMaxCost(estimate: GenerationEstimate): void {
    const cap =
      this.config.get<number>('ai.maxJobCostUsd') ??
      parseFloat(process.env.AI_MAX_JOB_COST_USD ?? '500');
    if (estimate.estimatedCostUsd > cap) {
      throw new BadRequestException(
        `Estimated job cost $${estimate.estimatedCostUsd.toFixed(2)} exceeds the per-job cap of $${cap.toFixed(2)}.`,
      );
    }
  }

  /**
   * Count questions matching the filters, estimate cost + duration, and
   * stash the params in Redis keyed by a short-lived confirmation token.
   */
  async preview(dto: ExplanationPreviewDto): Promise<ExplanationPreviewResult> {
    const ids = await this.resolveQuestionIds(dto.filters);
    if (ids.length === 0) {
      throw new BadRequestException('No questions match these filters.');
    }

    const sample = await this.questionsRepo.find({
      where: ids.slice(0, 3).map((id) => ({ id })),
      select: ['id', 'body'],
    });

    const estimate = estimateExplanationJob(ids.length, dto.model);
    this.assertUnderMaxCost(estimate);
    const confirmationToken = randomUUID();
    await this.redis.setJson(
      previewKey(confirmationToken),
      { dto, ids, estimate },
      PREVIEW_TTL_SECONDS,
    );

    return {
      confirmationToken,
      expiresAt: new Date(
        Date.now() + PREVIEW_TTL_SECONDS * 1000,
      ).toISOString(),
      matchingQuestions: ids.length,
      estimate,
      sample: sample.map((s) => ({
        id: s.id,
        body: s.body.slice(0, 240),
      })),
    };
  }

  async generate(
    adminId: string,
    dto: ExplanationGenerateDto,
  ): Promise<AiGenerationJob> {
    const stashed = await this.redis.getJson<{
      dto: ExplanationPreviewDto;
      ids: string[];
      estimate: GenerationEstimate;
    }>(previewKey(dto.confirmationToken));
    if (!stashed) {
      throw new BadRequestException(
        'Preview token expired or invalid — call /admin/explanations/preview again.',
      );
    }

    await this.redis.del(previewKey(dto.confirmationToken));

    const job = this.jobsRepo.create({
      jobType: AiJobType.EXPLANATION_BULK,
      status: AiJobStatus.PENDING,
      triggeredBy: adminId,
      parameters: {
        dto: stashed.dto,
        questionIds: stashed.ids,
      } as unknown as Record<string, unknown>,
      totalItems: stashed.ids.length,
      estimatedCostUsd: stashed.estimate.estimatedCostUsd.toFixed(4),
      modelUsed: resolveModelId(stashed.dto.model),
    });
    await this.jobsRepo.save(job);

    await this.queue.add(
      'explanation-bulk',
      { jobId: job.id },
      { removeOnComplete: true, attempts: 1 },
    );
    return job;
  }

  listJobs(): Promise<AiGenerationJob[]> {
    return this.jobsRepo.find({
      where: { jobType: AiJobType.EXPLANATION_BULK },
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }

  async getJob(id: string): Promise<AiGenerationJob> {
    const job = await this.jobsRepo.findOne({ where: { id } });
    if (!job || job.jobType !== AiJobType.EXPLANATION_BULK) {
      throw new NotFoundException('Job not found');
    }
    return job;
  }

  /**
   * Server-Sent Events stream of job progress (spec §5.1). Emits a status
   * frame every 2 seconds while pending/running and closes on terminal state.
   */
  streamProgress(id: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let closed = false;
      const tick = async (): Promise<void> => {
        if (closed) return;
        try {
          const job = await this.getJob(id);
          const total = job.totalItems ?? 0;
          const processed = job.completedItems ?? 0;
          const failed = job.failedItems ?? 0;
          const remaining = Math.max(0, total - processed - failed);
          subscriber.next({
            data: {
              id: job.id,
              status: job.status,
              processed,
              failed,
              total,
              costSoFarUsd: job.actualCostUsd,
              etaSeconds: job.status === AiJobStatus.RUNNING ? remaining : null,
            },
          } as MessageEvent);
          if (
            job.status !== AiJobStatus.PENDING &&
            job.status !== AiJobStatus.RUNNING
          ) {
            subscriber.complete();
            closed = true;
          }
        } catch (err) {
          subscriber.error(err);
          closed = true;
        }
      };
      void tick();
      const timer = setInterval(() => {
        void tick();
      }, 2000);
      return () => {
        closed = true;
        clearInterval(timer);
      };
    });
  }

  /**
   * Paginated list of questions that still need an explanation. Admin UI
   * renders this as a backlog count + a browse view.
   */
  async listPending(params: {
    examType?: ExamType;
    subjectId?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));

    const qb = this.questionsRepo
      .createQueryBuilder('q')
      .where('q.explanation IS NULL')
      .andWhere("q.status = 'active'");
    if (params.examType)
      qb.andWhere('q.exam_type = :et', { et: params.examType });
    if (params.subjectId)
      qb.andWhere('q.subject_id = :sid', { sid: params.subjectId });

    qb.orderBy('q.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();
    return { items, total, nextCursor: null };
  }

  /**
   * Single-question regen: creates a one-shot AiGenerationJob, enqueues it.
   * The worker overwrites `questions.explanation` when it succeeds.
   */
  async regenerate(
    adminId: string,
    questionId: string,
    model: 'claude-haiku' | 'claude-sonnet' = 'claude-sonnet',
  ): Promise<AiGenerationJob> {
    const exists = await this.questionsRepo.findOne({
      where: { id: questionId },
    });
    if (!exists) throw new NotFoundException('Question not found');

    const estimate = estimateExplanationJob(1, model);
    const job = this.jobsRepo.create({
      jobType: AiJobType.EXPLANATION_BULK,
      status: AiJobStatus.PENDING,
      triggeredBy: adminId,
      parameters: {
        dto: { model, filters: { questionIds: [questionId] } },
        questionIds: [questionId],
        regenerate: true,
      } as unknown as Record<string, unknown>,
      totalItems: 1,
      estimatedCostUsd: estimate.estimatedCostUsd.toFixed(4),
      modelUsed: resolveModelId(model),
    });
    await this.jobsRepo.save(job);

    await this.queue.add(
      'explanation-bulk',
      { jobId: job.id },
      { removeOnComplete: true, attempts: 1 },
    );
    return job;
  }

  /** Resolve filter → id list once so preview count == generate count. */
  private async resolveQuestionIds(
    filters: ExplanationFiltersDto,
  ): Promise<string[]> {
    if (filters.questionIds && filters.questionIds.length > 0) {
      return filters.questionIds;
    }
    const qb = this.questionsRepo
      .createQueryBuilder('q')
      .select('q.id', 'id')
      .where("q.status = 'active'");

    if (filters.hasExplanation === false) {
      qb.andWhere('q.explanation IS NULL');
    } else if (filters.hasExplanation === true) {
      qb.andWhere('q.explanation IS NOT NULL');
    }
    if (filters.examType)
      qb.andWhere('q.exam_type = :et', { et: filters.examType });
    if (filters.subjectIds && filters.subjectIds.length > 0) {
      qb.andWhere('q.subject_id IN (:...sids)', { sids: filters.subjectIds });
    }
    if (filters.yearRange) {
      qb.andWhere('q.year BETWEEN :from AND :to', {
        from: filters.yearRange.from,
        to: filters.yearRange.to,
      });
    }
    const rows = await qb.getRawMany<{ id: string }>();
    return rows.map((r) => r.id);
  }

  /**
   * Unused alt path — kept so a future endpoint can list questions grouped by
   * has/no explanation without touching the service internals.
   */
  countByExplanationPresence(): Promise<{
    total: number;
    withExplanation: number;
  }> {
    return Promise.all([
      this.questionsRepo.count(),
      this.questionsRepo.count({ where: { explanation: Not(IsNull()) } }),
    ]).then(([total, withExplanation]) => ({ total, withExplanation }));
  }

  /** Kept exported for potential use in admin analytics. */
  countByYearRange(from: number, to: number): Promise<number> {
    return this.questionsRepo.count({ where: { year: Between(from, to) } });
  }
}
