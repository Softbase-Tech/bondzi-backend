import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  LearningMaterialChunk,
  LearningMaterialChunkType,
} from './entities/learning-material-chunk.entity';
import { AiService } from '../ai/ai.service';

/**
 * Ingest + admin CRUD for MoE Learner-Material chunks (Knowledge
 * Layer, premium plan §4 / remediation 0.9).
 *
 * Ingest flow: the offline extractor
 * (`syllabus-extraction/extract_learning_material.py`) parses one
 * textbook PDF into chunk JSON; `push_learning_material.py` POSTs it
 * to the admin ingest endpoint; this service resolves each chunk's
 * `syllabus_topic_id` through the sub-strand → content-standard →
 * syllabus_topics bridge, inserts, and embeds.
 *
 * Embeddings use AiService.embed — the SAME embedder as
 * syllabus_indicators, recorded per row so an ingest/query model
 * mismatch is detectable.
 */

export interface IngestChunkDto {
  formLevel: number;
  strandCode?: string | null;
  subStrandCode?: string | null;
  sectionCode?: string | null;
  sectionTitle: string;
  chunkType: LearningMaterialChunkType;
  bodyMd: string;
  sourcePdf: string;
  sourcePage?: number | null;
}

const CHUNK_TYPES: ReadonlySet<string> = new Set([
  'key_ideas',
  'introduction',
  'example',
  'activity',
  'content',
]);

@Injectable()
export class LearningMaterialService {
  private readonly logger = new Logger(LearningMaterialService.name);

  constructor(
    @InjectRepository(LearningMaterialChunk)
    private readonly chunksRepo: Repository<LearningMaterialChunk>,
    private readonly dataSource: DataSource,
    private readonly ai: AiService,
  ) {}

  /**
   * Ingest one subject's chunk set. `replace: true` clears the
   * subject+form's existing chunks first (re-runs after extractor
   * fixes). Fails loudly on unmappable rows rather than silently
   * orphaning them — a section that can't be typed is an extractor
   * bug worth surfacing.
   */
  async ingest(args: {
    subjectId: string;
    chunks: IngestChunkDto[];
    replace?: boolean;
  }): Promise<{ inserted: number; embedded: number; topicLinked: number }> {
    if (!args.chunks.length) {
      throw new BadRequestException('No chunks supplied.');
    }
    for (const [i, c] of args.chunks.entries()) {
      if (!CHUNK_TYPES.has(c.chunkType)) {
        throw new BadRequestException(
          `chunk[${i}] has unknown chunkType "${c.chunkType}"`,
        );
      }
      if (!c.bodyMd?.trim() || !c.sectionTitle?.trim() || !c.sourcePdf) {
        throw new BadRequestException(
          `chunk[${i}] missing bodyMd / sectionTitle / sourcePdf`,
        );
      }
    }

    if (args.replace) {
      const forms = [...new Set(args.chunks.map((c) => c.formLevel))];
      await this.chunksRepo
        .createQueryBuilder()
        .delete()
        .where('subject_id = :sid AND form_level IN (:...forms)', {
          sid: args.subjectId,
          forms,
        })
        .execute();
    }

    let inserted = 0;
    let topicLinked = 0;
    const insertedIds: string[] = [];
    for (const c of args.chunks) {
      const syllabusTopicId = await this.resolveTopicId(
        args.subjectId,
        c.strandCode ?? null,
        c.subStrandCode ?? null,
        c.formLevel,
      );
      if (syllabusTopicId) topicLinked += 1;
      const row = await this.chunksRepo.save(
        this.chunksRepo.create({
          subjectId: args.subjectId,
          formLevel: c.formLevel,
          strandCode: c.strandCode ?? null,
          subStrandCode: c.subStrandCode ?? null,
          sectionCode: c.sectionCode ?? null,
          sectionTitle: c.sectionTitle.trim(),
          chunkType: c.chunkType,
          bodyMd: c.bodyMd.trim(),
          sourcePdf: c.sourcePdf,
          sourcePage: c.sourcePage ?? null,
          syllabusTopicId,
        }),
      );
      insertedIds.push(row.id);
      inserted += 1;
    }

    const embedded = await this.embedChunks(insertedIds);
    this.logger.log(
      `[learning-material] ingested subject=${args.subjectId} chunks=${inserted} embedded=${embedded} topicLinked=${topicLinked}`,
    );
    return { inserted, embedded, topicLinked };
  }

  /** Admin list with filters — powers the reviewer view. */
  async list(params: {
    subjectId?: string;
    formLevel?: number;
    chunkType?: string;
    q?: string;
    page: number;
    limit: number;
  }): Promise<{ items: LearningMaterialChunk[]; total: number }> {
    const qb = this.chunksRepo.createQueryBuilder('c');
    if (params.subjectId)
      qb.andWhere('c.subject_id = :sid', { sid: params.subjectId });
    if (params.formLevel != null)
      qb.andWhere('c.form_level = :fl', { fl: params.formLevel });
    if (params.chunkType)
      qb.andWhere('c.chunk_type = :ct', { ct: params.chunkType });
    if (params.q?.trim()) {
      qb.andWhere(
        `to_tsvector('english', coalesce(c.section_title,'') || ' ' || c.body_md) @@ plainto_tsquery('english', :q)`,
        { q: params.q.trim() },
      );
    }
    qb.orderBy('c.section_code', 'ASC', 'NULLS LAST')
      .addOrderBy('c.created_at', 'ASC')
      .take(params.limit)
      .skip((params.page - 1) * params.limit);
    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }

  /**
   * Admin spot-fix (OCR artefacts, math re-typesetting). Body edits
   * invalidate + recompute the embedding so retrieval never serves a
   * stale vector for corrected text.
   */
  async updateBody(id: string, bodyMd: string): Promise<LearningMaterialChunk> {
    const row = await this.chunksRepo.findOne({ where: { id } });
    if (!row) throw new BadRequestException('Chunk not found');
    if (!bodyMd?.trim()) throw new BadRequestException('bodyMd is required');
    row.bodyMd = bodyMd.trim();
    row.embeddingModel = null;
    row.embeddedAt = null;
    await this.chunksRepo.save(row);
    await this.dataSource.query(
      `UPDATE learning_material_chunks SET embedding = NULL WHERE id = $1`,
      [id],
    );
    await this.embedChunks([id]);
    return (await this.chunksRepo.findOne({ where: { id } }))!;
  }

  async remove(id: string): Promise<void> {
    await this.chunksRepo.delete({ id });
  }

  /** Coverage gauge: % of a subject's chunks that are topic-linked + embedded. */
  async coverage(subjectId: string): Promise<{
    total: number;
    embedded: number;
    topicLinked: number;
    byType: Record<string, number>;
  }> {
    const rows: Array<{
      chunk_type: string;
      total: string;
      embedded: string;
      linked: string;
    }> = await this.dataSource.query(
      `SELECT chunk_type,
              count(*)                                   AS total,
              count(*) FILTER (WHERE embedding IS NOT NULL)          AS embedded,
              count(*) FILTER (WHERE syllabus_topic_id IS NOT NULL)  AS linked
         FROM learning_material_chunks
        WHERE subject_id = $1
        GROUP BY chunk_type`,
      [subjectId],
    );
    const byType: Record<string, number> = {};
    let total = 0;
    let embedded = 0;
    let topicLinked = 0;
    for (const r of rows) {
      byType[r.chunk_type] = Number(r.total);
      total += Number(r.total);
      embedded += Number(r.embedded);
      topicLinked += Number(r.linked);
    }
    return { total, embedded, topicLinked, byType };
  }

  // -------------------------------------------------------------------------

  /**
   * Resolve a chunk's syllabus topic through the bridge:
   * sub-strand code → content standards → syllabus_topics
   * (`source_content_standard_id`). A sub-strand can bridge several
   * topics; the first by sort_order is the canonical reading target.
   */
  private async resolveTopicId(
    subjectId: string,
    strandCode: string | null,
    subStrandCode: string | null,
    formLevel: number,
  ): Promise<string | null> {
    if (!subStrandCode && !strandCode) return null;
    try {
      const rows: Array<{ id: string }> = await this.dataSource.query(
        `SELECT t.id
           FROM syllabus_topics t
           JOIN syllabus_content_standards cs ON cs.id = t.source_content_standard_id
           JOIN syllabus_sub_strands ss ON ss.id = cs.sub_strand_id
           JOIN syllabus_strands s ON s.id = ss.strand_id
          WHERE t.subject_id = $1
            AND ($2::int IS NULL OR t.form_level = $2)
            AND ($3::text IS NULL OR ss.code = $3)
            AND ($4::text IS NULL OR s.code = $4)
          ORDER BY t.sort_order ASC
          LIMIT 1`,
        [subjectId, formLevel, subStrandCode, strandCode],
      );
      return rows[0]?.id ?? null;
    } catch (err) {
      this.logger.warn(
        `[learning-material] topic resolution failed subject=${subjectId} sub=${subStrandCode}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** Embed chunks in batches of 16; best-effort per batch. */
  private async embedChunks(ids: string[]): Promise<number> {
    let embedded = 0;
    for (let i = 0; i < ids.length; i += 16) {
      const slice = ids.slice(i, i + 16);
      const rows: Array<{ id: string; text: string }> =
        await this.dataSource.query(
          `SELECT id, section_title || E'\\n' || body_md AS text
             FROM learning_material_chunks
            WHERE id = ANY($1::uuid[])`,
          [slice],
        );
      if (!rows.length) continue;
      try {
        const { vectors, model } = await this.ai.embed(rows.map((r) => r.text));
        for (let j = 0; j < rows.length; j++) {
          const vec = vectors[j];
          if (!vec?.length) continue;
          await this.dataSource.query(
            `UPDATE learning_material_chunks
                SET embedding = $1::vector, embedding_model = $2, embedded_at = now()
              WHERE id = $3`,
            [`[${vec.join(',')}]`, model, rows[j].id],
          );
          embedded += 1;
        }
      } catch (err) {
        this.logger.warn(
          `[learning-material] embed batch failed (${slice.length} chunks): ${(err as Error).message}`,
        );
      }
    }
    return embedded;
  }
}
