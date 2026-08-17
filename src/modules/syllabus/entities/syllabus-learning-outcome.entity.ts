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
import { SyllabusSubStrand } from './syllabus-sub-strand.entity';

/**
 * NaCCA Learning Outcome (Table A) — e.g. `1.1.1.LO.1` "Solve problems
 * involving properties of binary operations."
 *
 * The outcomes describe what the learner should be able to do; the
 * examinable knowledge + worked examples live on the Content Standards
 * / Indicators (Table B), joined by the shared `{strand}.{subStrand}.{n}`
 * code prefix. Kept as its own table so the overview is preserved, but
 * the atomic groundable unit is the Indicator, not the Outcome.
 */
@Entity({ name: 'syllabus_learning_outcomes' })
@Unique('syllabus_learning_outcomes_uq', ['subStrandId', 'code'])
@Index('idx_syllabus_learning_outcomes_sub_strand', ['subStrandId'])
export class SyllabusLearningOutcome {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'sub_strand_id', type: 'uuid' })
  subStrandId: string;

  @ManyToOne(() => SyllabusSubStrand, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sub_strand_id' })
  subStrand: SyllabusSubStrand;

  /** Learning-outcome code as printed, e.g. `1.1.1.LO.1`. */
  @Column({ type: 'text' })
  code: string;

  @Column({ type: 'text' })
  statement: string;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
