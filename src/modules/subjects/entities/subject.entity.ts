import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ExamType, SubjectCategory } from '../../../common/types/enums';
import { Topic } from './topic.entity';

@Entity({ name: 'subjects' })
@Index('subjects_code_idx', ['code'], { unique: true })
@Index('idx_subjects_exam_type', ['examType', 'isActive'])
export class Subject {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text', unique: true })
  code: string;

  @Column({ type: 'text' })
  name: string;

  // v2: every subject belongs to exactly one exam platform.
  @Column({ name: 'exam_type', type: 'enum', enum: ExamType })
  examType: ExamType;

  @Column({
    type: 'enum',
    enum: SubjectCategory,
    default: SubjectCategory.CORE,
  })
  category: SubjectCategory;

  @Column({ name: 'is_core', type: 'bool', default: false })
  isCore: boolean;

  @Column({ name: 'is_active', type: 'bool', default: true })
  isActive: boolean;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  // is_active=false was the previous "archive" mechanism; deleted_at
  // is the typed soft-delete TypeORM understands. New deletes should
  // set deleted_at; the existing is_active flag remains as a separate
  // "visible-but-unselectable" signal.
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;

  @OneToMany(() => Topic, (t) => t.subject)
  topics: Topic[];
}
