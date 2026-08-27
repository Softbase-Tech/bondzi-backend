import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AiService } from '../ai/ai.service';

/**
 * Knowledge Layer retrieval (premium plan §4 / remediation Layer 1–3).
 *
 * One retrieval service, two shapes, five consumers:
 *
 *   Shape 1 — retrieveForGeneration: a bounded bundle of learning-
 *   material chunks for a generation call (question gen, explanation
 *   gen, answer verifier). Deterministic KEY_IDEAS + INTRODUCTION for
 *   the target scope, plus the nearest EXAMPLE chunks by pgvector
 *   cosine similarity, plus at most one ACTIVITY for register.
 *   Ceiling ~2,500 tokens; diversity budget stops a batch's exemplars
 *   all coming from one page.
 *
 *   Shape 2 — retrieveForRemediation: citation METADATA ONLY (ids,
 *   section titles, pages) for a set of weak topics. Powers the
 *   Weakness Detector / AI Review / Post-Exam Review "Read: <section>"
 *   recommendations. Chunk bodies are deliberately NOT returned —
 *   student-facing features cite and deep-link reading material, they
 *   don't paste textbook pages into prompts.
 *
 * Same embedder as syllabus_indicators (AiService.embed) — one model
 * platform-wide, ingest-time model == query-time model.
 */

export interface RetrievedChunk {
  id: string;
  chunkType: string;
  sectionCode: string | null;
  sectionTitle: string;
  bodyMd: string;
  sourcePage: number | null;
}

export interface GenerationBundle {
  keyIdeas: RetrievedChunk[];
  introduction: RetrievedChunk | null;
  examples: RetrievedChunk[];
  activity: RetrievedChunk | null;
  /** True when the subject has no ingested material for this scope. */
  empty: boolean;
}

export interface RemediationRef {
  syllabusTopicId: string;
  chunks: Array<{
    id: string;
    chunkType: string;
    sectionTitle: string;
    sourcePage: number | null;
  }>;
}

/** Rough char budget ≈ 2,500 tokens of retrieved material. */
const BUNDLE_CHAR_BUDGET = 10_000;
const MAX_EXAMPLES = 3;
const MAX_KEY_IDEAS = 2;

@Injectable()
export class KnowledgeRetrievalService {
  private readonly logger = new Logger(KnowledgeRetrievalService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly ai: AiService,
  ) {}

  /**
   * Skip-guard mirror of SyllabusRetrievalService.hasEmbeddedIndicators
   * — callers avoid paying an embed round-trip for subjects with no
   * ingested learning material.
   */
  async hasChunks(subjectId: string): Promise<boolean> {
    const rows: Array<{ exists: boolean }> = await this.dataSource.query(
      `SELECT EXISTS (
         SELECT 1 FROM learning_material_chunks WHERE subject_id = $1
       ) AS exists`,
      [subjectId],
    );
    return rows[0]?.exists === true;
  }

  /** Shape 1 — generation-time bundle. */
  async retrieveForGeneration(params: {
    subjectId: string;
    formLevel: number | null;
    /** Query text — cleaned indicator statement / topic title / stem. */
    queryText: string;
    /** Narrow deterministic blocks to a sub-strand when known. */
    subStrandCode?: string | null;
  }): Promise<GenerationBundle> {
    const empty: GenerationBundle = {
      keyIdeas: [],
      introduction: null,
      examples: [],
      activity: null,
      empty: true,
    };
    const text = params.queryText?.trim();
    if (!text) return empty;

    // Deterministic blocks: KEY_IDEAS + INTRODUCTION for the scope.
    const scopeFilter = params.subStrandCode
      ? `AND c.sub_strand_code = $4`
      : ``;
    const scopeArgs: unknown[] = [
      params.subjectId,
      params.formLevel ?? null,
      MAX_KEY_IDEAS + 1,
    ];
    if (params.subStrandCode) scopeArgs.push(params.subStrandCode);
    const deterministic: RetrievedChunk[] = await this.dataSource.query(
      `SELECT c.id, c.chunk_type AS "chunkType", c.section_code AS "sectionCode",
              c.section_title AS "sectionTitle", c.body_md AS "bodyMd",
              c.source_page AS "sourcePage"
         FROM learning_material_chunks c
        WHERE c.subject_id = $1
          AND ($2::int IS NULL OR c.form_level = $2)
          AND c.chunk_type IN ('key_ideas','introduction')
          ${scopeFilter}
        ORDER BY c.chunk_type, c.section_code NULLS LAST
        LIMIT $3`,
      scopeArgs,
    );

    // Similarity block: nearest EXAMPLEs (+ maybe an activity).
    let similar: RetrievedChunk[] = [];
    try {
      const { vectors } = await this.ai.embed([text]);
      const vec = vectors[0];
      if (vec && vec.length > 0) {
        similar = await this.dataSource.query(
          `SELECT c.id, c.chunk_type AS "chunkType", c.section_code AS "sectionCode",
                  c.section_title AS "sectionTitle", c.body_md AS "bodyMd",
                  c.source_page AS "sourcePage"
             FROM learning_material_chunks c
            WHERE c.subject_id = $2
              AND ($3::int IS NULL OR c.form_level = $3)
              AND c.chunk_type IN ('example','activity','content')
              AND c.embedding IS NOT NULL
            ORDER BY c.embedding <=> $1::vector
            LIMIT $4`,
          [
            `[${vec.join(',')}]`,
            params.subjectId,
            params.formLevel ?? null,
            MAX_EXAMPLES + 2,
          ],
        );
      }
    } catch (err) {
      // Best-effort: deterministic blocks alone still ground facts.
      this.logger.warn(
        `[knowledge] similarity retrieval failed subject=${params.subjectId}: ${(err as Error).message}`,
      );
    }

    // Assemble under the char budget with the diversity rules:
    // ≤2 key-ideas, 1 introduction, ≤3 examples (≤2 per section), ≤1 activity.
    const bundle: GenerationBundle = {
      keyIdeas: [],
      introduction: null,
      examples: [],
      activity: null,
      empty: false,
    };
    let budget = BUNDLE_CHAR_BUDGET;
    const take = (c: RetrievedChunk): boolean => {
      if (c.bodyMd.length > budget) return false;
      budget -= c.bodyMd.length;
      return true;
    };
    for (const c of deterministic) {
      if (
        c.chunkType === 'key_ideas' &&
        bundle.keyIdeas.length < MAX_KEY_IDEAS
      ) {
        if (take(c)) bundle.keyIdeas.push(c);
      } else if (c.chunkType === 'introduction' && !bundle.introduction) {
        if (take(c)) bundle.introduction = c;
      }
    }
    const perSection = new Map<string, number>();
    for (const c of similar) {
      const sec = c.sectionCode ?? c.sectionTitle;
      if (c.chunkType === 'activity') {
        if (!bundle.activity && take(c)) bundle.activity = c;
        continue;
      }
      if (bundle.examples.length >= MAX_EXAMPLES) continue;
      if ((perSection.get(sec) ?? 0) >= 2) continue;
      if (take(c)) {
        bundle.examples.push(c);
        perSection.set(sec, (perSection.get(sec) ?? 0) + 1);
      }
    }
    bundle.empty =
      bundle.keyIdeas.length === 0 &&
      !bundle.introduction &&
      bundle.examples.length === 0;
    return bundle;
  }

  /**
   * Shape 2 — remediation citations for weak topics. Metadata only.
   * Prefers key_ideas (the "read this first" unit), then introduction,
   * then the first example.
   */
  async retrieveForRemediation(params: {
    syllabusTopicIds: string[];
    maxChunksPerTopic?: number;
  }): Promise<RemediationRef[]> {
    const ids = params.syllabusTopicIds.filter(Boolean);
    if (ids.length === 0) return [];
    const cap = Math.max(1, Math.min(4, params.maxChunksPerTopic ?? 2));
    const rows: Array<{
      syllabusTopicId: string;
      id: string;
      chunkType: string;
      sectionTitle: string;
      sourcePage: number | null;
    }> = await this.dataSource.query(
      `SELECT c.syllabus_topic_id AS "syllabusTopicId", c.id,
              c.chunk_type AS "chunkType", c.section_title AS "sectionTitle",
              c.source_page AS "sourcePage"
         FROM (
           SELECT *,
                  row_number() OVER (
                    PARTITION BY syllabus_topic_id
                    ORDER BY CASE chunk_type
                               WHEN 'key_ideas' THEN 0
                               WHEN 'introduction' THEN 1
                               WHEN 'example' THEN 2
                               ELSE 3
                             END,
                             section_code NULLS LAST
                  ) AS rn
             FROM learning_material_chunks
            WHERE syllabus_topic_id = ANY($1::uuid[])
         ) c
        WHERE c.rn <= $2`,
      [ids, cap],
    );
    const byTopic = new Map<string, RemediationRef>();
    for (const r of rows) {
      const ref = byTopic.get(r.syllabusTopicId) ?? {
        syllabusTopicId: r.syllabusTopicId,
        chunks: [],
      };
      ref.chunks.push({
        id: r.id,
        chunkType: r.chunkType,
        sectionTitle: r.sectionTitle,
        sourcePage: r.sourcePage,
      });
      byTopic.set(r.syllabusTopicId, ref);
    }
    return [...byTopic.values()];
  }

  /**
   * Render a Shape-1 bundle as the `<data type="reference_material">`
   * body the prompt builders inject. Roles are labelled so the shell's
   * deviation policy has something to bind to.
   */
  renderReferenceMaterial(bundle: GenerationBundle): string {
    if (bundle.empty) return '';
    const parts: string[] = [];
    for (const k of bundle.keyIdeas) {
      parts.push(
        `[KEY IDEAS — definitional truth, zero deviation] ${k.sectionTitle}\n${k.bodyMd}`,
      );
    }
    if (bundle.introduction) {
      parts.push(
        `[INTRODUCTION — scope + framing, paraphrase allowed] ${bundle.introduction.sectionTitle}\n${bundle.introduction.bodyMd}`,
      );
    }
    for (const e of bundle.examples) {
      parts.push(
        `[WORKED EXAMPLE — mirror method + step density, use NOVEL numbers] ${e.sectionTitle}\n${e.bodyMd}`,
      );
    }
    if (bundle.activity) {
      parts.push(
        `[ACTIVITY — student-facing register only, never copy] ${bundle.activity.sectionTitle}\n${bundle.activity.bodyMd}`,
      );
    }
    return parts.join('\n\n---\n\n');
  }
}
