import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { QUEUE_EMAIL } from '../ai/ai.queues';
import { MailEvent, MailPayloadByEvent } from './mail.types';
import { MailSendOptions, QueuedMailJob } from './mail-send.options';

@Injectable()
export class MailQueueService {
  constructor(@InjectQueue(QUEUE_EMAIL) private readonly queue: Queue) {}

  async enqueue<E extends MailEvent>(
    event: E,
    to: string,
    payload: MailPayloadByEvent[E],
    options?: MailSendOptions,
  ): Promise<void> {
    const job: QueuedMailJob = {
      event,
      to,
      payload: payload as unknown as Record<string, unknown>,
      options,
    };
    await this.queue.add('send', job, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: 1000,
      removeOnFail: 500,
    });
  }
}
