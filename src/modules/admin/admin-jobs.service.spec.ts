import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { AdminJobsService } from './admin-jobs.service';
import { QUEUE_AI_GENERATION, QUEUE_NOTIFICATIONS } from '../ai/ai.queues';

/**
 * Thin BullMQ wrapper. Tests pin:
 *   - list aggregates getJobCounts over EVERY registered queue, never letting
 *     `undefined` from BullMQ leak as NaN downstream.
 *   - failed returns [] for an unregistered queue name (safe public API).
 *   - failed maps Job<D>.data to `unknown` (no `any` leak).
 */

describe('AdminJobsService', () => {
  let service: AdminJobsService;
  let aiQueue: { getJobCounts: jest.Mock; getJobs: jest.Mock };
  let notifQueue: { getJobCounts: jest.Mock; getJobs: jest.Mock };

  beforeEach(async () => {
    aiQueue = { getJobCounts: jest.fn(), getJobs: jest.fn() };
    notifQueue = { getJobCounts: jest.fn(), getJobs: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminJobsService,
        { provide: getQueueToken(QUEUE_AI_GENERATION), useValue: aiQueue },
        { provide: getQueueToken(QUEUE_NOTIFICATIONS), useValue: notifQueue },
      ],
    }).compile();
    service = moduleRef.get(AdminJobsService);
  });

  it('list returns a row per queue with undefined counts coerced to 0', async () => {
    aiQueue.getJobCounts.mockResolvedValueOnce({
      waiting: 3,
      active: 1,
      completed: 10,
      // failed/delayed/paused intentionally omitted to exercise the coercion
    });
    notifQueue.getJobCounts.mockResolvedValueOnce({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: 0,
    });
    const out = await service.list();
    expect(out).toHaveLength(2);
    const ai = out.find((q) => q.name === QUEUE_AI_GENERATION)!;
    expect(ai).toEqual({
      name: QUEUE_AI_GENERATION,
      waiting: 3,
      active: 1,
      completed: 10,
      failed: 0, // coerced
      delayed: 0,
      paused: 0,
    });
  });

  it('failed returns [] for an unregistered queue name', async () => {
    expect(await service.failed('bogus-queue')).toEqual([]);
    expect(aiQueue.getJobs).not.toHaveBeenCalled();
  });

  it('failed maps Job<D> fields onto the public DTO and clamps limit to >= 1', async () => {
    aiQueue.getJobs.mockResolvedValueOnce([
      {
        id: 'j1',
        name: 'gen-explanations',
        failedReason: 'timeout',
        attemptsMade: 3,
        timestamp: 100,
        data: { questionId: 'q1' },
      },
    ]);
    const out = await service.failed(QUEUE_AI_GENERATION, 0);
    expect(aiQueue.getJobs).toHaveBeenCalledWith(['failed'], 0, 0); // max(1,0)-1
    expect(out[0]).toEqual({
      id: 'j1',
      name: 'gen-explanations',
      failedReason: 'timeout',
      attemptsMade: 3,
      timestamp: 100,
      data: { questionId: 'q1' },
    });
  });
});
