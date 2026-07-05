import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AiGenerationRejectLog } from './entities/ai-generation-reject-log.entity';
import { AiGenerationRejectAgg } from './entities/ai-generation-reject-agg.entity';

const RAW_RETENTION_DAYS = 30;
// Truncate raw model output to keep a runaway 100k-token response from
// blowing up the log. 16 KiB is comfortably above a typical rejection
// blob (JSON with 20 questions) and well below anything abusive.
const RAW_OUTPUT_MAX_CHARS = 16 * 1024;

export interface RecordRejectInput {
  jobId?: string | null;
  action: 'question_generation' | 'explanation';
  provider: 'bedrock' | 'ollama';
  model: string;
  reason: string;
  detail?: string | null;
  rawOutput?: string | null;
}

/**
 * Writes reject records to the log AND upserts the weekly aggregate
 * in one transaction, so the two never drift. Also owns the 30-day
 * retention prune (the raw log; the agg is retained indefinitely).
 */
@Injectable()
export class RejectLogService {
  private readonly logger = new Logger(RejectLogService.name);

  constructor(
    @InjectRepository(AiGenerationRejectLog)
    private readonly rawRepo: Repository<AiGenerationRejectLog>,
    @InjectRepository(AiGenerationRejectAgg)
    private readonly aggRepo: Repository<AiGenerationRejectAgg>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Records a rejection atomically. Insert into the raw log +
   * UPSERT-increment into the weekly aggregate live in the same
   * transaction — a partial write would let the aggregate lie
   * about actual failure counts.
   *
   * Best-effort by design: the CALLER (the AI processor) should
   * NEVER let a reject-log write kill the parent generation loop.
   * Wrap the call in a try/catch and just log a warning if this
   * throws — losing a reject-log row is preferable to failing an
   * otherwise-fine batch.
   */
  async record(input: RecordRejectInput): Promise<void> {
    const weekStart = mondayOfWeekIso(new Date());
    const truncated =
      input.rawOutput != null && input.rawOutput.length > RAW_OUTPUT_MAX_CHARS
        ? input.rawOutput.slice(0, RAW_OUTPUT_MAX_CHARS) + '\n…[truncated]'
        : (input.rawOutput ?? null);

    await this.dataSource.transaction(async (em) => {
      await em.getRepository(AiGenerationRejectLog).insert({
        jobId: input.jobId ?? null,
        action: input.action,
        provider: input.provider,
        model: input.model,
        reason: input.reason,
        detail: input.detail ?? null,
        rawOutput: truncated,
      });
      // UPSERT increment on the composite PK. Raw INSERT via query
      // rather than repo.upsert so `count` increments atomically on
      // conflict — the ORM's upsert path would overwrite, not add.
      await em.query(
        `insert into "ai_generation_reject_agg"
           ("week_start", "reason", "provider", "model", "count", "updated_at")
         values ($1::date, $2, $3, $4, 1, now())
         on conflict ("week_start", "reason", "provider", "model") do update
           set "count" = "ai_generation_reject_agg"."count" + 1,
               "updated_at" = now();`,
        [weekStart, input.reason, input.provider, input.model],
      );
    });
  }

  /**
   * Retention cron. Called by NotificationRetentionJob's sibling in
   * `src/jobs/ai-reject-retention.job.ts` (weekly). Returns the
   * affected row count for logging.
   */
  async pruneRawOlderThanDays(days = RAW_RETENTION_DAYS): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const result = await this.rawRepo
      .createQueryBuilder()
      .delete()
      .from(AiGenerationRejectLog)
      .where('created_at < :cutoff', { cutoff })
      .execute();
    const affected = result.affected ?? 0;
    if (affected > 0) {
      this.logger.log(
        `[ai-reject-log] pruned ${affected} raw rows older than ${days}d (cutoff=${cutoff.toISOString()})`,
      );
    }
    return affected;
  }

  /**
   * Admin read — the raw log, filtered + paged. Used by the /admin/ai
   * reject browser.
   */
  listRaw(opts: {
    limit?: number;
    offset?: number;
    reason?: string;
    provider?: string;
    model?: string;
  }): Promise<[AiGenerationRejectLog[], number]> {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const offset = Math.max(0, opts.offset ?? 0);
    const qb = this.rawRepo
      .createQueryBuilder('r')
      .orderBy('r.created_at', 'DESC')
      .take(limit)
      .skip(offset);
    if (opts.reason) qb.andWhere('r.reason = :r', { r: opts.reason });
    if (opts.provider) qb.andWhere('r.provider = :p', { p: opts.provider });
    if (opts.model) qb.andWhere('r.model = :m', { m: opts.model });
    return qb.getManyAndCount();
  }

  /** Admin read — full aggregate. Used for trend charts. */
  listAgg(): Promise<AiGenerationRejectAgg[]> {
    return this.aggRepo.find({
      order: { weekStart: 'DESC', reason: 'ASC', model: 'ASC' },
    });
  }
}

/**
 * Monday-of-week UTC as `YYYY-MM-DD`. Matches the leaderboard week
 * boundary — pick one consistent week-boundary convention so admin
 * dashboards can cross-reference cleanly.
 */
function mondayOfWeekIso(d: Date): string {
  const utc = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const dayOfWeek = utc.getUTCDay(); // 0=Sun, 1=Mon ... 6=Sat
  const shift = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  utc.setUTCDate(utc.getUTCDate() - shift);
  return utc.toISOString().slice(0, 10);
}
