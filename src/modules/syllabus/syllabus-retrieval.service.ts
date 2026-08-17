import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AiService } from '../ai/ai.service';
import { ExamType } from '../../common/types/enums';

export interface RetrievedIndicator {
  id: string;
  code: string;
  statement: string;
  workedContent: string | null;
  targetDokLevels: number[] | null;
  contentStandardCode: string;
  contentStandardStatement: string;
  /** Cosine similarity in [0,1]; higher is closer. */
  score: number;
}

/**
 * Hybrid semantic retrieval over approved, embedded syllabus indicators.
 * Metadata filter first (subject + form), then pgvector nearest‑neighbour by
 * cosine distance (`<=>`) using the HNSW index. Consumed by explanation /
 * question generation and the AI review to ground on the exact indicators.
 *
 * The same embedding model is used for the query as for ingest (via
 * AiService.embed) — vectors from different models are not comparable.
 */
@Injectable()
export class SyllabusRetrievalService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ai: AiService,
  ) {}

  /**
   * Cheap existence check: does the subject have at least one approved,
   * embedded indicator? Callers use this as a skip-guard so they never pay
   * for an embedding query on subjects that aren't ingested yet (the
   * explanation path runs per-question, so this avoids one wasted embed +
   * round-trip per question on un-ingested subjects).
   */
  async hasEmbeddedIndicators(subjectId: string): Promise<boolean> {
    const rows: Array<{ exists: boolean }> = await this.dataSource.query(
      `SELECT EXISTS (
         SELECT 1 FROM syllabus_indicators
          WHERE subject_id = $1
            AND status = 'approved'
            AND embedding IS NOT NULL
       ) AS exists`,
      [subjectId],
    );
    return rows[0]?.exists === true;
  }

  async retrieve(params: {
    subjectId: string;
    queryText: string;
    formLevel?: number | null;
    examType?: ExamType;
    k?: number;
  }): Promise<RetrievedIndicator[]> {
    const text = params.queryText?.trim();
    if (!text) return [];

    const { vectors } = await this.ai.embed([text]);
    const vec = vectors[0];
    if (!vec || vec.length === 0) return [];

    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT i.id,
              i.code,
              i.statement,
              i.worked_content        AS "workedContent",
              i.target_dok_levels     AS "targetDokLevels",
              cs.code                 AS "contentStandardCode",
              cs.statement            AS "contentStandardStatement",
              1 - (i.embedding <=> $1::vector) AS score
         FROM syllabus_indicators i
         JOIN syllabus_content_standards cs ON cs.id = i.content_standard_id
        WHERE i.subject_id = $2
          AND i.status = 'approved'
          AND i.embedding IS NOT NULL
          AND ($3::int IS NULL OR i.form_level = $3)
        ORDER BY i.embedding <=> $1::vector
        LIMIT $4`,
      [
        `[${vec.join(',')}]`,
        params.subjectId,
        params.formLevel ?? null,
        params.k ?? 5,
      ],
    );

    return rows.map((r) => ({
      id: r.id as string,
      code: r.code as string,
      statement: r.statement as string,
      workedContent: (r.workedContent as string | null) ?? null,
      targetDokLevels: (r.targetDokLevels as number[] | null) ?? null,
      contentStandardCode: r.contentStandardCode as string,
      contentStandardStatement: r.contentStandardStatement as string,
      score: Number(r.score),
    }));
  }
}
