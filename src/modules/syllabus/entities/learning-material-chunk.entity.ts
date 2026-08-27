import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Subject } from '../../subjects/entities/subject.entity';
import { SyllabusTopic } from '../../subjects/entities/syllabus-topic.entity';

/**
 * One extracted chunk of an MoE Learner Material (textbook): a KEY
 * IDEAS block, a section INTRODUCTION, a worked EXAMPLE (+ its
 * solution, kept in the same chunk body), an ACTIVITY, or generic
 * CONTENT prose. The platform's authoritative fact source — see
 * migration 2270 and docs/ai-premium-quality-implementation.md §4.
 *
 * NOTE: the pgvector `embedding vector(1024)` column exists in the DB
 * but is deliberately NOT mapped here — same convention as
 * syllabus_indicators (TypeORM has no vector type; values move through
 * raw parameterised SQL in KnowledgeRetrievalService /
 * LearningMaterialService only).
 */
export type LearningMaterialChunkType =
  | 'key_ideas'
  | 'introduction'
  | 'example'
  | 'activity'
  | 'content';

@Entity({ name: 'learning_material_chunks' })
@Index('idx_lm_chunks_scope', [
  'subjectId',
  'formLevel',
  'strandCode',
  'subStrandCode',
])
export class LearningMaterialChunk {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'subject_id', type: 'uuid' })
  subjectId: string;

  @ManyToOne(() => Subject, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'subject_id' })
  subject: Subject;

  @Column({ name: 'form_level', type: 'int' })
  formLevel: number;

  /** NaCCA strand code the section maps to, e.g. "1". */
  @Column({ name: 'strand_code', type: 'text', nullable: true })
  strandCode: string | null;

  /** NaCCA sub-strand code, e.g. "1.1". */
  @Column({ name: 'sub_strand_code', type: 'text', nullable: true })
  subStrandCode: string | null;

  /** Section identifier as printed in the book, e.g. "1" or "1.3". */
  @Column({ name: 'section_code', type: 'text', nullable: true })
  sectionCode: string | null;

  @Column({ name: 'section_title', type: 'text' })
  sectionTitle: string;

  @Column({ name: 'chunk_type', type: 'text' })
  chunkType: LearningMaterialChunkType;

  /** Markdown body; math normalised to $...$ LaTeX at ingest. */
  @Column({ name: 'body_md', type: 'text' })
  bodyMd: string;

  @Column({ name: 'source_pdf', type: 'text' })
  sourcePdf: string;

  @Column({ name: 'source_page', type: 'int', nullable: true })
  sourcePage: number | null;

  /**
   * Resolved at ingest via the sub-strand → content-standard →
   * syllabus_topics bridge so remediation lookups are one join.
   */
  @Column({ name: 'syllabus_topic_id', type: 'uuid', nullable: true })
  syllabusTopicId: string | null;

  @ManyToOne(() => SyllabusTopic, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'syllabus_topic_id' })
  syllabusTopic: SyllabusTopic | null;

  /** Which embedder produced `embedding` (must match query-time model). */
  @Column({ name: 'embedding_model', type: 'text', nullable: true })
  embeddingModel: string | null;

  @Column({ name: 'embedded_at', type: 'timestamptz', nullable: true })
  embeddedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
