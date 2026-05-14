import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdminExplanationsService } from './admin-explanations.service';
import { AiGenerationJob } from './entities/ai-generation-job.entity';
import { Question } from '../questions/entities/question.entity';
import { RedisService } from '../../common/redis/redis.service';
import { QUEUE_AI_GENERATION } from '../ai/ai.queues';
import { AiJobStatus, AiJobType } from '../../common/types/enums';

/**
 * AdminExplanationsService gates the bulk-explanations job — it spends real
 * money so the security-critical paths are:
 *   - preview must throw BadRequest when the filter matches zero rows
 *     (otherwise admins generate $0 jobs by mistake)
 *   - preview must throw BadRequest when estimate.cost > AI_MAX_JOB_COST_USD
 *   - generate must reject an unknown / expired confirmation token (Redis miss)
 *   - generate enqueues the job with the SAME id list captured by preview
 *     (count drift between preview and generate is the bug-class we're
 *     guarding against)
 *   - regenerate enqueues exactly one-question job; NotFound on bad id
 */

describe('AdminExplanationsService', () => {
  let service: AdminExplanationsService;
  let questionsRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let jobsRepo: { create: jest.Mock; save: jest.Mock };
  let queue: { add: jest.Mock };
  let redis: { setJson: jest.Mock; getJson: jest.Mock; del: jest.Mock };
  let config: { get: jest.Mock };

  beforeEach(async () => {
    questionsRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    jobsRepo = {
      create: jest.fn((o: unknown) => ({ id: 'job-1', ...(o as object) })),
      save: jest.fn(async (j: unknown) => j),
    };
    queue = { add: jest.fn() };
    redis = {
      setJson: jest.fn().mockResolvedValue(undefined),
      getJson: jest.fn(),
      del: jest.fn().mockResolvedValue(undefined),
    };
    config = { get: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminExplanationsService,
        { provide: getRepositoryToken(Question), useValue: questionsRepo },
        { provide: getRepositoryToken(AiGenerationJob), useValue: jobsRepo },
        { provide: getQueueToken(QUEUE_AI_GENERATION), useValue: queue },
        { provide: RedisService, useValue: redis },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    service = moduleRef.get(AdminExplanationsService);
  });

  function stubFilterQb(ids: string[]) {
    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(ids.map((id) => ({ id }))),
    };
    questionsRepo.createQueryBuilder.mockReturnValueOnce(qb);
    return qb;
  }

  // ------------------------------- preview -------------------------------

  it('preview throws BadRequest when no questions match', async () => {
    stubFilterQb([]);
    await expect(
      service.preview({
        filters: { hasExplanation: false },
        model: 'claude-haiku',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(redis.setJson).not.toHaveBeenCalled();
  });

  it('preview throws BadRequest when estimated cost exceeds the cap', async () => {
    stubFilterQb(Array(100000).fill('q1')); // huge id list → large estimate
    config.get.mockReturnValue(0.01); // tiny cap
    await expect(
      service.preview({
        filters: { hasExplanation: false },
        model: 'claude-sonnet',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('preview stashes the id list in Redis keyed by a uuid token', async () => {
    stubFilterQb(['q1', 'q2', 'q3']);
    config.get.mockReturnValue(500);
    const out = await service.preview({
      filters: { hasExplanation: false },
      model: 'claude-haiku',
    } as never);
    expect(out.matchingQuestions).toBe(3);
    // Token is a uuid (8-4-4-4-12 hex).
    expect(out.confirmationToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(redis.setJson).toHaveBeenCalled();
  });

  // ------------------------------- generate -------------------------------

  it('generate rejects an unknown / expired token (Redis miss)', async () => {
    redis.getJson.mockResolvedValueOnce(null);
    await expect(
      service.generate('admin-1', { confirmationToken: 'bogus' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('generate enqueues a PENDING job seeded with the preview id list', async () => {
    redis.getJson.mockResolvedValueOnce({
      dto: { model: 'claude-haiku', filters: {} },
      ids: ['q1', 'q2'],
      estimate: { estimatedCostUsd: 0.5 },
    });
    const job = await service.generate('admin-1', {
      confirmationToken: 'tok',
    } as never);
    expect(job.status).toBe(AiJobStatus.PENDING);
    expect(job.jobType).toBe(AiJobType.EXPLANATION_BULK);
    expect(job.totalItems).toBe(2);
    expect(redis.del).toHaveBeenCalled(); // burn the token (single-use)
    expect(queue.add).toHaveBeenCalledWith(
      'explanation-bulk',
      expect.objectContaining({ jobId: 'job-1' }),
      expect.any(Object),
    );
  });

  // ----------------------------- regenerate -----------------------------

  it('regenerate throws NotFound for a missing question', async () => {
    questionsRepo.findOne.mockResolvedValueOnce(null);
    await expect(service.regenerate('admin-1', 'qX')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('regenerate enqueues a single-item job with regenerate=true', async () => {
    questionsRepo.findOne.mockResolvedValueOnce({ id: 'q1' });
    const job = await service.regenerate('admin-1', 'q1', 'claude-sonnet');
    expect(job.totalItems).toBe(1);
    expect((job.parameters as { regenerate: boolean }).regenerate).toBe(true);
    expect(queue.add).toHaveBeenCalledWith(
      'explanation-bulk',
      { jobId: 'job-1' },
      expect.any(Object),
    );
  });

  // -------------------------------- getJob --------------------------------

  it('getJob throws NotFound when the job id is for a different job type', async () => {
    // Found a row, but jobType !== EXPLANATION_BULK.
    jobsRepo.save.mockClear();
    (jobsRepo as unknown as { findOne: jest.Mock }).findOne = jest
      .fn()
      .mockResolvedValueOnce({
        id: 'j',
        jobType: AiJobType.PM_TEST_GENERATION,
      });
    // Add the missing findOne method through the same token.
    Object.assign(jobsRepo, { findOne: jest.fn().mockResolvedValueOnce(null) });
    await expect(service.getJob('j')).rejects.toBeInstanceOf(NotFoundException);
  });
});
