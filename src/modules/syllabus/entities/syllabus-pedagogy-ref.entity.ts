import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Subject } from '../../subjects/entities/subject.entity';
import { DEFAULT_CURRICULUM_VERSION } from './syllabus-strand.entity';

/**
 * Deduped pedagogical boilerplate. In the NaCCA document the
 * "21st-Century Skills & Competencies" and "GESI / SEL / National
 * Values" columns repeat near-verbatim across every learning outcome —
 * generic scaffolding, not subject knowledge.
 *
 * We store them ONCE here (per subject, or globally) instead of on
 * every indicator, and they are NEVER embedded / never used as
 * generation grounding. This keeps the retrieval corpus to actual
 * knowledge and removes the majority of the document's page volume from
 * the index.
 */
export type SyllabusPedagogyScope = 'subject' | 'global';

@Entity({ name: 'syllabus_pedagogy_refs' })
export class SyllabusPedagogyRef {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Null when `scope = 'global'`. */
  @Column({ name: 'subject_id', type: 'uuid', nullable: true })
  subjectId: string | null;

  @ManyToOne(() => Subject, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'subject_id' })
  subject: Subject | null;

  @Column({ type: 'text', default: 'subject' })
  scope: SyllabusPedagogyScope;

  @Column({ type: 'text', nullable: true })
  competencies: string | null;

  @Column({ name: 'gesi_sel_values', type: 'text', nullable: true })
  gesiSelValues: string | null;

  @Column({
    name: 'curriculum_version',
    type: 'text',
    default: DEFAULT_CURRICULUM_VERSION,
  })
  curriculumVersion: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
