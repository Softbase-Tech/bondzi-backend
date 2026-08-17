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
import { SyllabusStrand } from './syllabus-strand.entity';

/**
 * NaCCA Sub-strand — e.g. "Number and Algebraic Patterns" (code `1.1`)
 * under the "Modelling with Algebra" strand. Groups both the Learning
 * Outcomes (Table A) and the Content Standards (Table B) for the same
 * `{strand}.{subStrand}` code prefix.
 */
@Entity({ name: 'syllabus_sub_strands' })
@Unique('syllabus_sub_strands_uq', ['strandId', 'code'])
@Index('idx_syllabus_sub_strands_strand', ['strandId'])
export class SyllabusSubStrand {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'strand_id', type: 'uuid' })
  strandId: string;

  @ManyToOne(() => SyllabusStrand, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'strand_id' })
  strand: SyllabusStrand;

  /** Sub-strand code as printed, e.g. `1.1`. */
  @Column({ type: 'text' })
  code: string;

  @Column({ type: 'text' })
  title: string;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
