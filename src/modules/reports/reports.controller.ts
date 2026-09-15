import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/types/enums';
import { SnapshotService } from './snapshot/snapshot.service';
import { DailyRenderer } from './render/daily.renderer';
import { ReportJob } from './delivery/report.job';
import {
  resolveRange,
  shiftIso,
  eachDay,
  periodRangeFor,
  utcDateIso,
} from './date-range.util';
import { MetricsAggregatorService } from './aggregate/metrics-aggregator.service';
import { ReportDeliveryService } from './delivery/report-delivery.service';
import type { Period } from './aggregate/metric-rules';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Backfilling a year by accident would hammer the DB for an hour. */
const MAX_BACKFILL_DAYS = 92;

/**
 * Admin-only operations surface for reporting.
 *
 * `preview` is the one that earns its place: it renders a report and
 * sends nothing, which is how the layout gets iterated on without mailing
 * yourself forty test emails — and how anyone can check what last Tuesday
 * actually looked like without waiting for a cron.
 */
@ApiTags('admin')
@ApiExcludeController()
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('admin/reports')
export class ReportsController {
  constructor(
    private readonly snapshots: SnapshotService,
    private readonly renderer: DailyRenderer,
    private readonly job: ReportJob,
    private readonly aggregator: MetricsAggregatorService,
    private readonly deliveries: ReportDeliveryService,
  ) {}

  /**
   * The metrics behind the reports, for the admin UI.
   *
   * Aggregation lives here rather than in the client so the page and the
   * (future) weekly and monthly emails share one implementation of the
   * rules — summing a stock quantity like MRR across 30 days, or
   * averaging a rate across days of wildly different volume, both produce
   * numbers that look entirely plausible and are badly wrong.
   *
   * `ensure=true` backfills missing snapshots first. Off by default: a
   * month with gaps would otherwise compute 30 snapshots inside one HTTP
   * request.
   */
  @Get('metrics')
  async metrics(
    @Query('period') period?: string,
    @Query('date') date?: string,
    @Query('ensure') ensure?: string,
  ) {
    const p = this.validPeriod(period);
    const anchor = this.validDate(date) ?? utcDateIso(new Date());
    const range = periodRangeFor(p, anchor);
    const days = eachDay(range);

    if (ensure === 'true') {
      if (days.length > MAX_BACKFILL_DAYS) {
        throw new BadRequestException('range too large to backfill inline');
      }
      await this.snapshots.ensureRange(range);
    }

    const snapshots = await this.snapshots.load(range);
    return this.aggregator.aggregate(p, range, snapshots, days);
  }

  /**
   * Delivery audit.
   *
   * Closes a real blind spot: without this, a daily report that silently
   * stopped sending is invisible until somebody notices the absence —
   * and absence is exactly what a quiet day looks like.
   */
  @Get('deliveries')
  async deliveriesLog(@Query('limit') limit?: string) {
    const n = Math.min(Math.max(parseInt(limit ?? '14', 10) || 14, 1), 90);
    const rows = await this.deliveries.recentDeliveries('daily', n);
    return {
      items: rows.map((r) => ({
        reportType: r.reportType,
        periodStart: String(r.periodStart).slice(0, 10),
        status: r.status,
        attemptCount: r.attemptCount,
        recipients: r.recipients,
        error: r.error,
        sentAt: r.sentAt,
        claimedAt: r.claimedAt,
      })),
    };
  }

  private validPeriod(v?: string): Period {
    if (v === undefined) return 'day';
    if (v !== 'day' && v !== 'week' && v !== 'month') {
      throw new BadRequestException(
        `invalid period "${v}" (expected day, week or month)`,
      );
    }
    return v;
  }

  /**
   * Render without sending. Returns both parts so the plain-text version
   * — the one that actually gets read on a phone — can be checked too.
   */
  @Get('daily/preview')
  async preview(@Query('date') date?: string) {
    const day = this.validDate(date) ?? resolveRange('daily', new Date()).start;
    await this.snapshots.ensureRange({ start: day, end: day });
    const history = await this.snapshots.load({
      start: shiftIso(day, -6),
      end: day,
    });
    const today = history.find(
      (h) => String(h.snapshotDate).slice(0, 10) === day,
    );
    if (!today) throw new BadRequestException(`no snapshot for ${day}`);
    const rendered = this.renderer.render(today, history);
    return {
      date: day,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    };
  }

  /**
   * Send now. `date` targets a past period; `force=true` re-sends one
   * already marked sent (using a fresh dedup key, so MailService does not
   * refuse the deliberate duplicate).
   */
  @Post('daily/run')
  async run(
    @Query('date') date?: string,
    @Query('force') force?: string,
  ): Promise<{ status: string; range: { start: string; end: string } }> {
    return this.job.runReport('daily', {
      date: this.validDate(date),
      force: force === 'true',
    });
  }

  /** Recompute snapshots for a range without sending anything. */
  @Post('snapshot/backfill')
  async backfill(@Query('from') from: string, @Query('to') to: string) {
    const start = this.validDate(from);
    const end = this.validDate(to);
    if (!start || !end) {
      throw new BadRequestException('from and to are required (YYYY-MM-DD)');
    }
    if (start > end) throw new BadRequestException('from must be <= to');
    const days = eachDay({ start, end });
    if (days.length > MAX_BACKFILL_DAYS) {
      throw new BadRequestException(
        `range too large (${days.length} days, max ${MAX_BACKFILL_DAYS})`,
      );
    }
    // Recompute unconditionally — the caller asked for a rebuild, which is
    // the point of the endpoint. `ensureRange` only fills gaps.
    for (const d of days) {
      await this.snapshots.computeAndPersist(d, { backfilled: true });
    }
    return { recomputed: days.length, from: start, to: end };
  }

  private validDate(v?: string): string | undefined {
    if (!v) return undefined;
    if (!ISO_DATE.test(v)) {
      throw new BadRequestException(
        `invalid date "${v}" (expected YYYY-MM-DD)`,
      );
    }
    return v;
  }
}
