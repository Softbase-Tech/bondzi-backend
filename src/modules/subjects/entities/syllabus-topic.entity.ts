import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ExamType } from '../../../common/types/enums';
import { Subject } from './subject.entity';

/**
 * v2 curriculum-aligned topics used by Bondzi Test AI generation. Distinct
 * from the past-paper `topics` table which links to real exam questions.
 */
@Entity({ name: 'syllabus_topics' })
@Index('idx_syllabus_topics_subject_level', [
  'subjectId',
  'formLevel',
  'examType',
])
export class SyllabusTopic {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'subject_id', type: 'uuid' })
  subjectId: string;

  @ManyToOne(() => Subject, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'subject_id' })
  subject: Subject;

  @Column({ name: 'exam_type', type: 'enum', enum: ExamType })
  examType: ExamType;

  @Column({ name: 'form_level', type: 'int' })
  formLevel: number;

  @Column({ type: 'text' })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'is_active', type: 'bool', default: true })
  isActive: boolean;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  /**
   * Points at the `syllabus_content_standards` row this topic was
   * derived from. NULL for topics an admin hand-authored via the
   * subject-detail CRUD. Set for topics synced by the syllabus
   * ingestion pipeline (2220... migration). The sync path is
   * idempotent: it only writes rows whose `source_content_standard_id`
   * does not already exist.
   */
  @Column({ name: 'source_content_standard_id', type: 'uuid', nullable: true })
  sourceContentStandardId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
