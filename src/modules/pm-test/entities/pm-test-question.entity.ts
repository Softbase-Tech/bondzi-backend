import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import {
  Difficulty,
  ExamType,
  QuestionStatus,
  QuestionType,
} from '../../../common/types/enums';
import { Subject } from '../../subjects/entities/subject.entity';
import { SyllabusTopic } from '../../subjects/entities/syllabus-topic.entity';
import { PmTestOption } from './pm-test-option.entity';

/**
 * v2 AI-generated Bondzi Test questions. Structurally similar to past-paper
 * questions but linked to syllabus_topics (not past-paper topics) and scoped by
 * form_level. Enters the pool with status=pending_review and is promoted to
 * status=active only after admin review.
 */
@Entity({ name: 'pm_test_questions' })
@Index('idx_pm_test_q_level', ['examType', 'formLevel', 'subjectId', 'status'])
export class PmTestQuestion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'subject_id', type: 'uuid' })
  subjectId: string;

  @ManyToOne(() => Subject, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'subject_id' })
  subject: Subject;

  /**
   * @deprecated Superseded by `syllabusIndicatorId` (the NaCCA hierarchy).
   * Kept nullable during the migration so nothing breaks; dropped in a
   * later cleanup migration once all consumers read indicators.
   */
  @Column({ name: 'syllabus_topic_id', type: 'uuid', nullable: true })
  syllabusTopicId: string | null;

  @ManyToOne(() => SyllabusTopic, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'syllabus_topic_id' })
  syllabusTopic: SyllabusTopic | null;

  /**
   * Canonical link into the NaCCA curriculum spine (a `syllabus_indicators`
   * row). Nullable while ingestion + backfill are in progress. FK is
   * enforced at the DB level (ON DELETE SET NULL) via the migration; kept
   * as a plain column to avoid cross-module relation coupling.
   */
  @Column({ name: 'syllabus_indicator_id', type: 'uuid', nullable: true })
  syllabusIndicatorId: string | null;

  @Column({ name: 'exam_type', type: 'enum', enum: ExamType })
  examType: ExamType;

  @Column({ name: 'form_level', type: 'int' })
  formLevel: number;

  @Column({
    name: 'question_type',
    type: 'enum',
    enum: QuestionType,
    default: QuestionType.MCQ,
  })
  questionType: QuestionType;

  @Column({ type: 'text' })
  body: string;

  // Explanation is generated inline with the question.
  @Column({ type: 'text', nullable: true })
  explanation: string | null;

  @Column({ type: 'enum', enum: Difficulty, default: Difficulty.MEDIUM })
  difficulty: Difficulty;

  @Column({
    type: 'enum',
    enum: QuestionStatus,
    default: QuestionStatus.PENDING_REVIEW,
  })
  status: QuestionStatus;

  @Column({ name: 'generation_batch_id', type: 'uuid', nullable: true })
  generationBatchId: string | null;

  @Column({ name: 'times_answered', type: 'int', default: 0 })
  timesAnswered: number;

  @Column({ name: 'times_correct', type: 'int', default: 0 })
  timesCorrect: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @OneToMany(() => PmTestOption, (o) => o.question, { cascade: true })
  options: PmTestOption[];
}
