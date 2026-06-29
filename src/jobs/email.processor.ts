import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_EMAIL } from '../modules/ai/ai.queues';
import { MailService } from '../modules/mail/mail.service';
import { MailEvent, MailPayloadByEvent } from '../modules/mail/mail.types';
import { QueuedMailJob } from '../modules/mail/mail-send.options';

@Injectable()
@Processor(QUEUE_EMAIL, { concurrency: 3 })
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(private readonly mail: MailService) {
    super();
  }

  async process(job: Job<QueuedMailJob>): Promise<{ ok: boolean }> {
    const { event, to, payload, options } = job.data;
    try {
      await this.mail.send(
        event,
        to,
        payload as unknown as MailPayloadByEvent[MailEvent],
        { ...options, sync: true },
      );
      return { ok: true };
    } catch (err) {
      this.logger.error(
        `[email-queue] job=${job.id} event=${event} failed: ${(err as Error).message}`,
      );
      throw err;
    }
  }
}
