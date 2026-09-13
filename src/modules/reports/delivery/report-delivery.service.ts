import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ReportDelivery,
  type ReportType,
} from '../entities/report-delivery.entity';
import { MailService } from '../../mail/mail.service';
import { MailEvent } from '../../mail/mail.types';
import type { RenderedReport } from '../render/daily.renderer';
import type { DateRange } from '../date-range.util';

/**
 * A `sending` row older than this is treated as unknown-outcome and may be
 * taken over. Long enough that a slow-but-live send is not stolen from,
 * short enough that a crashed run is retried on the next attempt.
 */
const STALE_CLAIM_MS = 30 * 60 * 1000;

export interface ClaimResult {
  alreadySent: boolean;
  attempt: number;
}

/**
 * Owns the delivery ledger and the send itself.
 *
 * **Claim before sending, not after.** An earlier design sent the email
 * and then wrote the ledger, which meant a crash in between produced a
 * second email on the next run. Claiming first inverts that: the worst
 * case is a `sending` row for a send that did happen, and the next run
 * sees it and asks MailService — whose `email_sends.dedup_key` is claimed
 * atomically *before* the Resend call — which refuses the duplicate.
 *
 * That is the real guarantee. This ledger is delivery audit and retry
 * bookkeeping; the dedup key is what makes double-sending impossible.
 */
@Injectable()
export class ReportDeliveryService {
  private readonly logger = new Logger(ReportDeliveryService.name);

  constructor(
    @InjectRepository(ReportDelivery)
    private readonly repo: Repository<ReportDelivery>,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  recipientsFor(type: ReportType): string[] {
    return this.config.get<string[]>(`reports.recipients.${type}`) ?? [];
  }

  /**
   * Take the period, or report that it is already done.
   *
   * `force` re-sends an already-sent period — used by the admin re-run
   * endpoint. It changes the dedup key suffix so MailService does not
   * refuse the deliberate duplicate.
   */
  async claim(
    type: ReportType,
    range: DateRange,
    recipients: string[],
    force = false,
  ): Promise<ClaimResult> {
    const existing = await this.repo.findOne({
      where: { reportType: type, periodStart: range.start },
    });

    if (existing && !force) {
      if (existing.status === 'sent')
        return { alreadySent: true, attempt: existing.attemptCount };
      if (
        existing.status === 'sending' &&
        Date.now() - new Date(existing.claimedAt).getTime() < STALE_CLAIM_MS
      ) {
        // Another runner has it and is probably still working.
        return { alreadySent: true, attempt: existing.attemptCount };
      }
    }

    // Lifecycle in one row: (none|failed|stale sending) -> sending.
    await this.repo
      .createQueryBuilder()
      .insert()
      .into(ReportDelivery)
      .values({
        reportType: type,
        periodStart: range.start,
        periodEnd: range.end,
        recipients,
        status: 'sending',
        attemptCount: 1,
        claimedAt: new Date(),
      })
      .orUpdate(
        [
          'status',
          'attempt_count',
          'claimed_at',
          'recipients',
          'period_end',
          'error',
        ],
        ['report_type', 'period_start'],
      )
      .execute();

    // `orUpdate` cannot express `attempt_count + 1` portably, so bump it
    // explicitly for the retry case.
    if (existing) {
      await this.repo.increment(
        { reportType: type, periodStart: range.start },
        'attemptCount',
        1,
      );
    }
    return { alreadySent: false, attempt: (existing?.attemptCount ?? 0) + 1 };
  }

  /**
   * Send to each recipient with a per-recipient dedup key, so a partial
   * failure retries only the address that did not get it.
   */
  async send(
    type: ReportType,
    range: DateRange,
    recipients: string[],
    rendered: RenderedReport,
    force = false,
  ): Promise<void> {
    // A deliberate re-run needs a key the ledger has not seen, or
    // MailService correctly refuses it as a duplicate.
    const suffix = force ? `:force:${Date.now()}` : '';
    for (const to of recipients) {
      await this.mail.send(
        MailEvent.OPS_REPORT,
        to,
        {
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
        },
        {
          dedupKey: `report:${type}:${range.start}:${to}${suffix}`,
          // Synchronous: a report is a handful of emails a day, and
          // queueing them would put delivery behind whatever else is in
          // the mail queue on a morning when the queue is the thing that
          // is broken.
          sync: true,
        },
      );
    }
  }

  async markSent(type: ReportType, range: DateRange): Promise<void> {
    await this.repo.update(
      { reportType: type, periodStart: range.start },
      { status: 'sent', sentAt: new Date(), error: null },
    );
  }

  async markFailed(
    type: ReportType,
    range: DateRange,
    error: string,
  ): Promise<void> {
    await this.repo.update(
      { reportType: type, periodStart: range.start },
      { status: 'failed', error: error.slice(0, 1000) },
    );
    this.logger.error(`[reports] ${type} ${range.start} failed: ${error}`);
  }

  async markSkipped(type: ReportType, range: DateRange): Promise<void> {
    await this.repo.update(
      { reportType: type, periodStart: range.start },
      { status: 'skipped' },
    );
  }

  /** Delivery audit for the weekly report: how many of the last N sent. */
  async recentDeliveries(
    type: ReportType,
    limit = 7,
  ): Promise<ReportDelivery[]> {
    return this.repo.find({
      where: { reportType: type },
      order: { periodStart: 'DESC' },
      take: limit,
    });
  }
}
