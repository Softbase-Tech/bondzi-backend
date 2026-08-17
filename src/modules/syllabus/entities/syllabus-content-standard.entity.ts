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
 * NaCCA Content Standard (Table B) — e.g. `1.1.1.CS.1` "Demonstrate
 * knowledge and understanding of binary operations, sets and binomial
 * theorem and solve related problems in real life situations."
 *
 * Owns the Learning Indicators (the atomic groundable units).
 */
@Entity({ name: 'syllabus_content_standards' })
@Unique('syllabus_content_standards_uq', ['subStrandId', 'code'])
@Index('idx_syllabus_content_standards_sub_strand', ['subStrandId'])
export class SyllabusContentStandard {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'sub_strand_id', type: 'uuid' })
  subStrandId: string;

  @ManyToOne(() => SyllabusSubStrand, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sub_strand_id' })
  subStrand: SyllabusSubStrand;

  /** Content-standard code as printed, e.g. `1.1.1.CS.1`. */
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
