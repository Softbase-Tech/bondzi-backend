import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Subject } from '../../subjects/entities/subject.entity';

/**
 * NaCCA standards-based curriculum — top of the knowledge hierarchy.
 *
 *   Strand → Sub-strand → { Content Standard → Indicator → Assessment item }
 *                          + Learning Outcome
 *
 * A strand is scoped to a subject AND a form level (Year 1–3), e.g.
 * "Modelling with Algebra" (code `1`) for Additional Mathematics,
 * Year One. `curriculum_version` lets a future curriculum edition
 * coexist with the current one without clobbering historical links.
 *
 * This is the STRUCTURED source of truth. Embeddings for retrieval are
 * derived from `syllabus_indicators` and added in a later migration
 * (they require the pgvector extension); the relational tables here
 * carry no vector dependency.
 */
export const DEFAULT_CURRICULUM_VERSION = 'nacca-2024';

@Entity({ name: 'syllabus_strands' })
@Unique('syllabus_strands_uq', [
  'subjectId',
  'formLevel',
  'curriculumVersion',
  'code',
])
@Index('idx_syllabus_strands_subject', ['subjectId', 'formLevel'])
export class SyllabusStrand {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'subject_id', type: 'uuid' })
  subjectId: string;

  @ManyToOne(() => Subject, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'subject_id' })
  subject: Subject;

  /** Year 1–3 (SHS form level). */
  @Column({ name: 'form_level', type: 'int' })
  formLevel: number;

  /** Strand code as printed, e.g. `1`. */
  @Column({ type: 'text' })
  code: string;

  @Column({ type: 'text' })
  title: string;

  @Column({
    name: 'curriculum_version',
    type: 'text',
    default: DEFAULT_CURRICULUM_VERSION,
  })
  curriculumVersion: string;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
