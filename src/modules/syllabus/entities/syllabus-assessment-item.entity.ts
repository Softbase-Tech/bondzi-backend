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
import { SyllabusIndicator } from './syllabus-indicator.entity';

/**
 * NaCCA Assessment item (Table B, Assessment column) — a curriculum-
 * supplied sample question per indicator, tagged by Depth-of-Knowledge
 * level. e.g. `1.1.1.AS.1`, DoK 1 (Recall) … DoK 4 (Extended critical
 * thinking and reasoning).
 *
 * These are gold for question generation: they are exemplars AND a
 * curriculum-native difficulty rubric. The DoK → difficulty mapping
 * (1 → easy, 2–3 → medium, 4 → hard) replaces the arbitrary difficulty
 * percentages used today.
 */
@Entity({ name: 'syllabus_assessment_items' })
@Index('idx_syllabus_assessment_items_indicator', ['indicatorId'])
export class SyllabusAssessmentItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'indicator_id', type: 'uuid' })
  indicatorId: string;

  @ManyToOne(() => SyllabusIndicator, (i) => i.assessmentItems, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'indicator_id' })
  indicator: SyllabusIndicator;

  /** Assessment code as printed, e.g. `1.1.1.AS.1`. */
  @Column({ type: 'text' })
  code: string;

  /** Depth-of-Knowledge level, 1–4. */
  @Column({ name: 'dok_level', type: 'int' })
  dokLevel: number;

  /** The sample question (LaTeX preserved). */
  @Column({ type: 'text' })
  question: string;

  /** Worked solution, when the curriculum supplies one. */
  @Column({ type: 'text', nullable: true })
  solution: string | null;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
