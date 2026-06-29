import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EmailSend, EmailSendStatus } from './entities/email-send.entity';

@Injectable()
export class EmailAuditService {
  private readonly logger = new Logger(EmailAuditService.name);

  constructor(
    @InjectRepository(EmailSend)
    private readonly repo: Repository<EmailSend>,
  ) {}

  /**
   * Atomically claim a dedup slot. Returns true when this caller won the
   * race and may proceed with the send; false when another send already
   * used this key.
   */
  async tryClaimDedup(args: {
    dedupKey: string;
    userId?: string;
    event: string;
    toEmail: string;
  }): Promise<boolean> {
    try {
      await this.repo.insert({
        userId: args.userId ?? null,
        event: args.event,
        toEmail: args.toEmail,
        dedupKey: args.dedupKey,
        status: 'skipped',
        error: 'pending',
      });
      return true;
    } catch (err) {
      if (this.isUniqueViolation(err)) return false;
      throw err;
    }
  }

  async record(args: {
    userId?: string;
    event: string;
    toEmail: string;
    dedupKey?: string;
    resendId?: string;
    status: EmailSendStatus;
    error?: string;
  }): Promise<void> {
    if (args.dedupKey) {
      const updated = await this.repo.update(
        { dedupKey: args.dedupKey },
        {
          userId: args.userId ?? null,
          event: args.event,
          toEmail: args.toEmail,
          resendId: args.resendId ?? null,
          status: args.status,
          error: args.error ?? null,
        },
      );
      if ((updated.affected ?? 0) > 0) return;
    }

    try {
      await this.repo.save(
        this.repo.create({
          userId: args.userId ?? null,
          event: args.event,
          toEmail: args.toEmail,
          dedupKey: args.dedupKey ?? null,
          resendId: args.resendId ?? null,
          status: args.status,
          error: args.error ?? null,
        }),
      );
    } catch (err) {
      if (args.dedupKey && this.isUniqueViolation(err)) return;
      this.logger.warn(
        `email audit write failed event=${args.event}: ${(err as Error).message}`,
      );
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    const code = (err as { code?: string })?.code;
    return code === '23505';
  }
}
