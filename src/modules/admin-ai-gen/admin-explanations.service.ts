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
import { AiService } from '../ai/ai.service';
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
    private readonly ai: AiService,
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
   * Returns true when the job's estimated cost exceeds the co-sign
   * threshold and a second admin must approve before processing.
   * AI_COSIGN_THRESHOLD_USD=0 disables the gate entirely.
   */
  private requiresCosign(estimate: GenerationEstimate): boolean {
    const threshold =
      this.config.get<number>('ai.cosignThresholdUsd') ??
      parseFloat(process.env.AI_COSIGN_THRESHOLD_USD ?? '50');
    return threshold > 0 && estimate.estimatedCostUsd > threshold;
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

    // Row-count backstop. AI_MAX_JOB_COST_USD gates on $, which is
    // meaningless on the Ollama path (local calls are $0). The
    // row-count cap is what prevents a mistyped filter from blasting
    // tens of thousands of explanations at prod on either provider.
    this.ai.assertBatchWithinCap(stashed.ids.length);

    const needsCosign = this.requiresCosign(stashed.estimate);

    const job = this.jobsRepo.create({
      jobType: AiJobType.EXPLANATION_BULK,
      status: needsCosign ? AiJobStatus.PENDING_APPROVAL : AiJobStatus.PENDING,
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

    if (needsCosign) {
      // Held — second admin must call approve() to enqueue. We DO NOT
      // enqueue the BullMQ job here. The admin UI surfaces these in a
      // "Pending approval" tab.
      this.logger.log(
        `[ai-cosign] held job=${job.id} cost=$${stashed.estimate.estimatedCostUsd.toFixed(2)} creator=${adminId}`,
      );
      return job;
    }

    await this.enqueue(job.id);
    return job;
  }

  /**
   * Second admin approves a PENDING_APPROVAL job, flips to PENDING, and
   * enqueues it. The approver MUST differ from the creator — the DB
   * CHECK constraint enforces this too, but we throw earlier with a
   * useful message.
   */
  async approveCosign(
    approverId: string,
    jobId: string,
  ): Promise<AiGenerationJob> {
    const job = await this.getJob(jobId);
    if (job.status !== AiJobStatus.PENDING_APPROVAL) {
      throw new BadRequestException(
        `Job ${jobId} is not awaiting approval (status=${job.status}).`,
      );
    }
    if (job.triggeredBy === approverId) {
      throw new BadRequestException(
        'Co-sign requires a different admin than the creator.',
      );
    }
    job.status = AiJobStatus.PENDING;
    job.approvedBy = approverId;
    job.approvedAt = new Date();
    await this.jobsRepo.save(job);
    await this.enqueue(job.id);
    this.logger.log(
      `[ai-cosign] approved job=${jobId} approver=${approverId} creator=${job.triggeredBy}`,
    );
    return job;
  }

  /** Admin rejects a pending-approval job — flips to CANCELLED. */
  async rejectCosign(
    approverId: string,
    jobId: string,
    reason?: string,
  ): Promise<AiGenerationJob> {
    const job = await this.getJob(jobId);
    if (job.status !== AiJobStatus.PENDING_APPROVAL) {
      throw new BadRequestException(
        `Job ${jobId} is not awaiting approval (status=${job.status}).`,
      );
    }
    job.status = AiJobStatus.CANCELLED;
    job.errorLog = `Rejected by ${approverId}: ${reason ?? 'no reason given'}`;
    await this.jobsRepo.save(job);
    this.logger.log(
      `[ai-cosign] rejected job=${jobId} approver=${approverId}: ${reason ?? 'n/a'}`,
    );
    return job;
  }

  /** Admin UI list of jobs waiting for a second-admin sign-off. */
  listPendingApproval(): Promise<AiGenerationJob[]> {
    return this.jobsRepo.find({
      where: {
        jobType: AiJobType.EXPLANATION_BULK,
        status: AiJobStatus.PENDING_APPROVAL,
      },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  private async enqueue(jobId: string): Promise<void> {
    await this.queue.add(
      'explanation-bulk',
      { jobId },
      // attempts=2 gives a single transient Bedrock 503 a second chance
      // without amplifying a real cost-runaway bug. Per-batch retries
      // INSIDE the processor (3 attempts, exponential) handle smaller
      // chunks; this outer retry is only for whole-job crashes.
      // removeOnFail bounds how many failed jobs accumulate in Redis —
      // the previous shape (default keep-forever) let them pile up.
      {
        removeOnComplete: { age: 24 * 3600, count: 200 },
        removeOnFail: { age: 7 * 24 * 3600, count: 100 },
        attempts: 2,
        backoff: { type: 'exponential', delay: 30_000 },
      },
    );
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
   * Surfaces actual token usage from ai_usage_log so admins can compare
   * the hardcoded TOKEN_ESTIMATES against reality. Used for #83 (token
   * estimate calibration): after a week of prod data, query the P50 +
   * P95 of input + output tokens here and bump the constants in
   * estimates.util.ts.
   */
  async calibrationReport(days = 7): Promise<
    Array<{
      model: string;
      action: string;
      n: number;
      p50_input: number;
      p50_output: number;
      p95_output: number;
    }>
  > {
    interface Row {
      model: string;
      action: string;
      n: string;
      p50_input: string | null;
      p50_output: string | null;
      p95_output: string | null;
    }
    const rows: Row[] = await this.jobsRepo.manager.query(
      `
      select
        model,
        action,
        count(*)::text as n,
        percentile_cont(0.5) within group (order by input_tokens) as p50_input,
        percentile_cont(0.5) within group (order by output_tokens) as p50_output,
        percentile_cont(0.95) within group (order by output_tokens) as p95_output
      from ai_usage_log
      where created_at > now() - ($1::int || ' days')::interval
        and input_tokens is not null
        and output_tokens is not null
      group by model, action
      order by n desc;
    `,
      [days],
    );
    return rows.map((r) => ({
      model: r.model,
      action: r.action,
      n: parseInt(r.n, 10),
      p50_input: Number(r.p50_input ?? 0),
      p50_output: Number(r.p50_output ?? 0),
      p95_output: Number(r.p95_output ?? 0),
    }));
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
      // attempts=2 gives a single transient Bedrock 503 a second chance
      // without amplifying a real cost-runaway bug. Per-batch retries
      // INSIDE the processor (3 attempts, exponential) handle smaller
      // chunks; this outer retry is only for whole-job crashes.
      // removeOnFail bounds how many failed jobs accumulate in Redis —
      // the previous shape (default keep-forever) let them pile up.
      {
        removeOnComplete: { age: 24 * 3600, count: 200 },
        removeOnFail: { age: 7 * 24 * 3600, count: 100 },
        attempts: 2,
        backoff: { type: 'exponential', delay: 30_000 },
      },
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
