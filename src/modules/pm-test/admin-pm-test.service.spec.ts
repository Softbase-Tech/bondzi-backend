import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdminPmTestService } from './admin-pm-test.service';
import { PmTestQuestion } from './entities/pm-test-question.entity';
import { PmTestOption } from './entities/pm-test-option.entity';
import { AiGenerationJob } from '../admin-ai-gen/entities/ai-generation-job.entity';
import { RedisService } from '../../common/redis/redis.service';
import { QUEUE_AI_GENERATION } from '../ai/ai.queues';
import { AiService } from '../ai/ai.service';
import {
  AiJobStatus,
  AiJobType,
  QuestionStatus,
} from '../../common/types/enums';

/**
 * AdminPmTestService gates the PM Test bulk-generation job. Critical paths:
 *   - preview validates that easy+medium+hard = 100% for every selection
 *   - preview rejects when total questions exceed the per-job cap
 *   - preview rejects when estimated cost exceeds AI_MAX_JOB_COST_USD
 *   - generate refuses an unknown / expired preview token (Redis miss)
 *   - bulkReview is best-effort: a row that fails to save returns ok=false
 *     but does NOT abort the rest of the batch
 *   - publish/archive throw NotFound on bad id
 */

describe('AdminPmTestService', () => {
  let service: AdminPmTestService;
  let qRepo: {
    findOne: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let oRepo: Record<string, unknown>;
  let jobsRepo: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
  };
  let queue: { add: jest.Mock };
  let redis: { setJson: jest.Mock; getJson: jest.Mock; del: jest.Mock };
  let config: { get: jest.Mock };
  let aiService: { assertBatchWithinCap: jest.Mock };

  beforeEach(async () => {
    qRepo = {
      findOne: jest.fn(),
      save: jest.fn(async (r: unknown) => r),
      createQueryBuilder: jest.fn(),
    };
    oRepo = {};
    jobsRepo = {
      create: jest.fn((o: unknown) => ({ id: 'job-1', ...(o as object) })),
      save: jest.fn(async (j: unknown) => j),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
    };
    queue = { add: jest.fn() };
    redis = {
      setJson: jest.fn().mockResolvedValue(undefined),
      getJson: jest.fn(),
      del: jest.fn().mockResolvedValue(undefined),
    };
    config = {
      get: jest.fn((key: string) => {
        // Tests targeting AI_MAX_ITEMS_PER_BATCH expect the assertion
        // to be a no-op for their sample sizes; return a large cap.
        if (key === 'ai.maxItemsPerBatch') return 10_000;
        return 500;
      }),
    };
    aiService = { assertBatchWithinCap: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminPmTestService,
        { provide: getRepositoryToken(PmTestQuestion), useValue: qRepo },
        { provide: getRepositoryToken(PmTestOption), useValue: oRepo },
        { provide: getRepositoryToken(AiGenerationJob), useValue: jobsRepo },
        { provide: getQueueToken(QUEUE_AI_GENERATION), useValue: queue },
        { provide: RedisService, useValue: redis },
        { provide: ConfigService, useValue: config },
        { provide: AiService, useValue: aiService },
      ],
    }).compile();
    service = moduleRef.get(AdminPmTestService);
  });

  // ---------------------------- preview ----------------------------

  it('preview rejects when a difficulty mix does not sum to 100%', async () => {
    await expect(
      service.preview({
        model: 'claude-haiku',
        batchSize: 5,
        selections: [
          {
            subjectId: 's',
            formLevel: 3,
            questionCount: 10,
            difficulty: { easy: 50, medium: 30, hard: 10 }, // 90
            mode: 'append',
          },
        ],
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('preview rejects when totalQuestions exceeds the per-job cap', async () => {
    await expect(
      service.preview({
        model: 'claude-haiku',
        batchSize: 5,
        selections: [
          {
            subjectId: 's',
            formLevel: 3,
            questionCount: 100_001,
            difficulty: { easy: 50, medium: 30, hard: 20 },
            mode: 'append',
          },
        ],
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('preview emits a "replace" warning when any selection uses mode=replace', async () => {
    const out = await service.preview({
      model: 'claude-haiku',
      batchSize: 5,
      selections: [
        {
          subjectId: 's',
          formLevel: 3,
          questionCount: 50,
          difficulty: { easy: 50, medium: 30, hard: 20 },
          mode: 'replace',
        },
      ],
    } as never);
    expect(out.warnings.some((w) => w.includes('replace'))).toBe(true);
    expect(redis.setJson).toHaveBeenCalled();
  });

  // ---------------------------- generate ----------------------------

  it('generate rejects an expired token', async () => {
    redis.getJson.mockResolvedValueOnce(null);
    await expect(
      service.generate('admin-1', { confirmationToken: 'tok' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('generate enqueues a PENDING PM_TEST_GENERATION job and burns the token', async () => {
    redis.getJson.mockResolvedValueOnce({
      dto: { model: 'claude-haiku' },
      estimate: { totalItems: 50, estimatedCostUsd: 1.5 },
    });
    const job = await service.generate('admin-1', {
      confirmationToken: 'tok',
    } as never);
    expect(job.status).toBe(AiJobStatus.PENDING);
    expect(job.jobType).toBe(AiJobType.PM_TEST_GENERATION);
    expect(job.totalItems).toBe(50);
    expect(redis.del).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      'pm-test-generation',
      { jobId: 'job-1' },
      expect.any(Object),
    );
  });

  // ---------------------------- bulkReview ----------------------------

  it('bulkReview returns ok=false for missing rows but continues the batch', async () => {
    qRepo.findOne
      .mockResolvedValueOnce(null) // first id missing
      .mockResolvedValueOnce({
        id: 'q2',
        status: QuestionStatus.PENDING_REVIEW,
      });
    const out = await service.bulkReview({
      items: [
        { id: 'q1', action: 'approve' },
        { id: 'q2', action: 'approve' },
      ],
    } as never);
    expect(out.results).toEqual([
      { id: 'q1', action: 'approve', ok: false },
      { id: 'q2', action: 'approve', ok: true },
    ]);
  });

  it('bulkReview approve flips status to ACTIVE, reject flips to ARCHIVED', async () => {
    const row1 = { id: 'q1', status: QuestionStatus.PENDING_REVIEW };
    const row2 = { id: 'q2', status: QuestionStatus.PENDING_REVIEW };
    qRepo.findOne.mockResolvedValueOnce(row1).mockResolvedValueOnce(row2);
    await service.bulkReview({
      items: [
        { id: 'q1', action: 'approve' },
        { id: 'q2', action: 'reject' },
      ],
    } as never);
    expect(row1.status).toBe(QuestionStatus.ACTIVE);
    expect(row2.status).toBe(QuestionStatus.ARCHIVED);
  });

  // --------------------------- publish / archive ---------------------------

  it('publish + archive throw NotFound on unknown id', async () => {
    qRepo.findOne.mockResolvedValueOnce(null);
    await expect(service.publish('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    qRepo.findOne.mockResolvedValueOnce(null);
    await expect(service.archive('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // -------------------------------- getJob --------------------------------

  it('getJob throws NotFound for a row of the wrong jobType', async () => {
    jobsRepo.findOne.mockResolvedValueOnce({
      id: 'j',
      jobType: AiJobType.EXPLANATION_BULK,
    });
    await expect(service.getJob('j')).rejects.toBeInstanceOf(NotFoundException);
  });
});
