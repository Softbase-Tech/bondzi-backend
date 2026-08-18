import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AiService } from '../ai/ai.service';

interface EmbedRow {
  id: string;
  statement: string;
  worked_content: string | null;
}

/**
 * Embeds APPROVED syllabus indicators into the pgvector `embedding` column so
 * `SyllabusRetrievalService` can do semantic search. The vector column is not
 * mapped on the entity (TypeORM has no `vector` type), so reads/writes here
 * go through raw SQL.
 *
 * Only approved indicators are embedded (the review gate). A row is (re)embedded
 * when it has no vector yet or was embedded with a different model — so
 * changing `AI_EMBEDDING_MODEL` triggers a clean re-embed.
 */
@Injectable()
export class SyllabusEmbeddingService {
  private readonly logger = new Logger(SyllabusEmbeddingService.name);
  private static readonly BATCH = 50;
  /** True while a background embed pass is running (single-flight guard). */
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly ai: AiService,
    private readonly config: ConfigService,
  ) {}

  private embeddingModel(): string {
    return (
      this.config.get<string>('ai.embeddingModel') ??
      'amazon.titan-embed-text-v2:0'
    );
  }

  /** Count of approved indicators still needing an up-to-date vector. */
  async pendingCount(): Promise<number> {
    const rows: Array<{ n: string }> = await this.dataSource.query(
      `SELECT count(*) AS n
         FROM syllabus_indicators
        WHERE status = 'approved'
          AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $1)`,
      [this.embeddingModel()],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Kick off an embed pass in the BACKGROUND and return immediately.
   *
   * Embedding thousands of indicators through Bedrock (paced at ~480 RPM)
   * takes minutes — far longer than any HTTP/gateway timeout — so the admin
   * endpoint must not await it. The pass is idempotent (code-keyed upsert of
   * the vector), so a crash mid-run is simply finished by the next trigger.
   * A single-flight guard prevents overlapping passes from double-embedding.
   */
  async startEmbedApproved(): Promise<{
    started: boolean;
    alreadyRunning: boolean;
    pending: number;
  }> {
    const pending = await this.pendingCount();
    if (this.running) {
      return { started: false, alreadyRunning: true, pending };
    }
    if (pending === 0) {
      return { started: false, alreadyRunning: false, pending: 0 };
    }
    this.running = true;
    // Fire-and-forget: run detached, never let a failure become an unhandled
    // rejection, and always clear the guard.
    void this.embedApproved()
      .catch((err: unknown) =>
        this.logger.error(
          `[syllabus] background embed failed: ${(err as Error).message}`,
        ),
      )
      .finally(() => {
        this.running = false;
      });
    return { started: true, alreadyRunning: false, pending };
  }

  /** Embed approved indicators missing an up-to-date vector. Returns the count. */
  async embedApproved(
    opts: { limit?: number } = {},
  ): Promise<{ embedded: number }> {
    const model = this.embeddingModel();

    const rows: EmbedRow[] = await this.dataSource.query(
      `SELECT id, statement, worked_content
         FROM syllabus_indicators
        WHERE status = 'approved'
          AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $1)
        ORDER BY created_at
        LIMIT $2`,
      [model, opts.limit ?? 5000],
    );
    if (rows.length === 0) return { embedded: 0 };

    let embedded = 0;
    for (let i = 0; i < rows.length; i += SyllabusEmbeddingService.BATCH) {
      const batch = rows.slice(i, i + SyllabusEmbeddingService.BATCH);
      const texts = batch.map((r) => this.embedText(r));
      const { vectors, model: usedModel } = await this.ai.embed(texts, {
        model,
        jobId: undefined,
      });
      for (let j = 0; j < batch.length; j += 1) {
        const vec = vectors[j];
        if (!vec || vec.length === 0) continue;
        await this.dataSource.query(
          `UPDATE syllabus_indicators
              SET embedding = $1::vector, embedding_model = $2, embedded_at = now()
            WHERE id = $3`,
          [`[${vec.join(',')}]`, usedModel, batch[j].id],
        );
        embedded += 1;
      }
    }
    this.logger.log(
      `[syllabus] embedded ${embedded} indicators (model=${model})`,
    );
    return { embedded };
  }

  private embedText(r: EmbedRow): string {
    return r.worked_content
      ? `${r.statement}\n\n${r.worked_content}`
      : r.statement;
  }
}
