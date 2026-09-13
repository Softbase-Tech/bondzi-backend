import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

export type ReportType = 'daily' | 'weekly' | 'monthly';
export type DeliveryStatus = 'sending' | 'sent' | 'failed' | 'skipped';

/**
 * Delivery audit for one report period.
 *
 * Exactly one row per `(reportType, periodStart)`, claimed *before* the
 * send and updated after it, so the lifecycle is
 * `sending → sent | failed` and a later retry takes the same row back to
 * `sending`. An earlier design inserted a separate `failed` row behind a
 * hard UNIQUE, which meant one failed attempt permanently blocked ever
 * recording `sent` for that period.
 *
 * This is bookkeeping, not the double-send guard — that is
 * `email_sends.dedup_key`, claimed atomically inside MailService before
 * the Resend call. A crash between sending and updating this row leaves a
 * stale `sending` whose age tells the next run the outcome is unknown; the
 * dedup key is what makes retrying it safe.
 */
@Entity('report_deliveries')
@Unique('uq_report_deliveries_period', ['reportType', 'periodStart'])
@Index('idx_report_deliveries_type_period', ['reportType', 'periodStart'])
export class ReportDelivery {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'report_type', type: 'text' })
  reportType: ReportType;

  @Column({ name: 'period_start', type: 'date' })
  periodStart: string;

  @Column({ name: 'period_end', type: 'date' })
  periodEnd: string;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  recipients: string[];

  @Column({ type: 'text' })
  status: DeliveryStatus;

  @Column({ name: 'attempt_count', type: 'integer', default: 1 })
  attemptCount: number;

  /** Resend's message id, for chasing a specific delivery with support. */
  @Column({ name: 'provider_id', type: 'text', nullable: true })
  providerId: string | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ name: 'claimed_at', type: 'timestamptz' })
  claimedAt: Date;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt: Date | null;
}
