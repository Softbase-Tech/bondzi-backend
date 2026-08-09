import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE_AI_GENERATION, QUEUE_NOTIFICATIONS } from '../ai/ai.queues';

export interface QueueSummary {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

export interface FailedJobSummary {
  id: string;
  name: string;
  failedReason: string | undefined;
  attemptsMade: number;
  timestamp: number;
  data: unknown;
}

/**
 * Thin wrapper over BullMQ's Queue API for the ops dashboard at
 * /admin/jobs. We expose only the queues that the app owns; queues that
 * show up on the Redis instance but aren't registered here are ignored so
 * noisy neighbours can't confuse operators.
 */
@Injectable()
export class AdminJobsService {
  private readonly queueMap: Record<string, Queue>;

  constructor(
    @InjectQueue(QUEUE_AI_GENERATION) aiQueue: Queue,
    @InjectQueue(QUEUE_NOTIFICATIONS) notifQueue: Queue,
  ) {
    this.queueMap = {
      [QUEUE_AI_GENERATION]: aiQueue,
      [QUEUE_NOTIFICATIONS]: notifQueue,
    };
  }

  async list(): Promise<QueueSummary[]> {
    const summaries: QueueSummary[] = [];
    for (const [name, queue] of Object.entries(this.queueMap)) {
      const counts = await queue.getJobCounts(
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
        'paused',
      );
      summaries.push({
        name,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
        paused: counts.paused ?? 0,
      });
    }
    return summaries;
  }

  async failed(queueName: string, limit = 50): Promise<FailedJobSummary[]> {
    const queue = this.queueMap[queueName];
    if (!queue) return [];
    const jobs = await queue.getJobs(['failed'], 0, Math.max(1, limit) - 1);
    return jobs.map((j) => ({
      id: j.id ?? '',
      name: j.name,
      failedReason: j.failedReason,
      attemptsMade: j.attemptsMade,
      timestamp: j.timestamp,
      // BullMQ Job<D> is parameterised; in this generic queue map we don't
      // narrow D, so widen to unknown rather than leak `any` to the caller.
      data: j.data as unknown,
    }));
  }
}
