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

  constructor(
    private readonly dataSource: DataSource,
    private readonly ai: AiService,
    private readonly config: ConfigService,
  ) {}

  /** Embed approved indicators missing an up-to-date vector. Returns the count. */
  async embedApproved(
    opts: { limit?: number } = {},
  ): Promise<{ embedded: number }> {
    const model =
      this.config.get<string>('ai.embeddingModel') ??
      'amazon.titan-embed-text-v2:0';

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
