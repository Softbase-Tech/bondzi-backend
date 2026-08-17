import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Subject } from '../../subjects/entities/subject.entity';
import { SyllabusContentStandard } from './syllabus-content-standard.entity';
import { SyllabusAssessmentItem } from './syllabus-assessment-item.entity';
import { DEFAULT_CURRICULUM_VERSION } from './syllabus-strand.entity';

/**
 * NaCCA Learning Indicator (Table B) — the ATOMIC UNIT of the whole
 * platform. Everything downstream (generated questions, explanations,
 * AI-review citations, the WAEC cross-map) references an indicator by
 * its `code`, e.g. `1.1.1.LI.1` "Explain binary operations and apply
 * that knowledge in solving related problems."
 *
 * `worked_content` holds the curriculum's own worked Examples + full
 * Solutions (LaTeX preserved) — the primary grounding text for
 * explanation generation. `assessmentItems` hold the DoK-tagged sample
 * questions the curriculum supplies per indicator.
 *
 * `subject_id` and `form_level` are DENORMALISED onto this row (they're
 * derivable via the content_standard → sub_strand → strand chain) so
 * the hot retrieval path can filter `WHERE subject_id = ? AND
 * form_level = ? AND status = 'approved'` without four joins. See the
 * retrieval query in the plan (§A6).
 *
 * The `embedding vector(N)` column is intentionally NOT here yet — it
 * requires the pgvector extension and is added in the embeddings-phase
 * migration once pgvector availability is confirmed. This table is a
 * pure relational structure with no vector dependency.
 */
export type SyllabusIndicatorStatus = 'draft' | 'approved';

export interface SyllabusSourceRef {
  subjectPdfKey?: string;
  pageFrom?: number;
  pageTo?: number;
}

@Entity({ name: 'syllabus_indicators' })
// LI codes are NOT unique per subject — they RESET inside each content
// standard (e.g. 1.1.1.CS.1 and 1.1.1.CS.2 both own a 1.1.1.LI.1, verified
// on the Chemistry corpus). Uniqueness is therefore scoped to the content
// standard, not the subject. (Migration 2190 alters this from the A1 form.)
@Unique('syllabus_indicators_uq', ['contentStandardId', 'code'])
// Hot retrieval path: filter by subject + form + status, then vector-search.
@Index('idx_syllabus_indicators_retrieval', [
  'subjectId',
  'formLevel',
  'status',
])
@Index('idx_syllabus_indicators_content_standard', ['contentStandardId'])
export class SyllabusIndicator {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'content_standard_id', type: 'uuid' })
  contentStandardId: string;

  @ManyToOne(() => SyllabusContentStandard, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'content_standard_id' })
  contentStandard: SyllabusContentStandard;

  // --- denormalised for retrieval ---
  @Column({ name: 'subject_id', type: 'uuid' })
  subjectId: string;

  @ManyToOne(() => Subject, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'subject_id' })
  subject: Subject;

  @Column({ name: 'form_level', type: 'int' })
  formLevel: number;
  // -----------------------------------

  /** Indicator code as printed, e.g. `1.1.1.LI.1`. */
  @Column({ type: 'text' })
  code: string;

  @Column({ type: 'text' })
  statement: string;

  /** Worked Examples + Solutions (LaTeX). The groundable knowledge. */
  @Column({ name: 'worked_content', type: 'text', nullable: true })
  workedContent: string | null;

  @Column({
    name: 'curriculum_version',
    type: 'text',
    default: DEFAULT_CURRICULUM_VERSION,
  })
  curriculumVersion: string;

  /** Provenance back to the source PDF in S3. */
  @Column({ name: 'source_ref', type: 'jsonb', nullable: true })
  sourceRef: SyllabusSourceRef | null;

  /**
   * Review gate: extraction lands rows as `draft`; only an admin-
   * approved `approved` indicator is eligible for embedding + used as
   * generation/explanation grounding.
   */
  @Column({ type: 'text', default: 'draft' })
  status: SyllabusIndicatorStatus;

  /**
   * The embedding model that produced this row's vector (e.g.
   * `amazon.titan-embed-text-v2:0`). Stored so a model/dimension change
   * is detectable and triggers re-embedding. The `embedding vector(1024)`
   * column itself is added in migration 2180 but NOT mapped here —
   * TypeORM has no `vector` type, so it is read/written via raw SQL.
   */
  @Column({ name: 'embedding_model', type: 'text', nullable: true })
  embeddingModel: string | null;

  @Column({ name: 'embedded_at', type: 'timestamptz', nullable: true })
  embeddedAt: Date | null;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @OneToMany(() => SyllabusAssessmentItem, (item) => item.indicator, {
    cascade: true,
  })
  assessmentItems: SyllabusAssessmentItem[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
