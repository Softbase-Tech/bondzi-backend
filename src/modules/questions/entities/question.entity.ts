import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  Difficulty,
  ExamType,
  QuestionSource,
  QuestionStatus,
  QuestionType,
} from '../../../common/types/enums';
import { Subject } from '../../subjects/entities/subject.entity';
import { Topic } from '../../subjects/entities/topic.entity';
import { Option } from './option.entity';
import { QuestionStimulus } from './question-stimulus.entity';
import { WorkedExample } from '../types/worked-example';

@Entity({ name: 'questions' })
@Index('questions_subject_idx', ['subjectId'])
@Index('questions_topic_idx', ['topicId'])
@Index('questions_year_idx', ['year'])
@Index('questions_difficulty_idx', ['difficulty'])
@Index('idx_questions_exam_type', ['examType', 'status'])
@Index('idx_questions_subject_year', ['subjectId', 'year'])
export class Question {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'subject_id', type: 'uuid' })
  subjectId: string;

  @ManyToOne(() => Subject, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'subject_id' })
  subject: Subject;

  @Column({ name: 'topic_id', type: 'uuid', nullable: true })
  topicId: string | null;

  @ManyToOne(() => Topic, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'topic_id' })
  topic: Topic | null;

  /**
   * Link into the NaCCA curriculum spine (a `syllabus_indicators` row).
   * Past-paper questions predate the curriculum, so this is populated by
   * the semantic past-paper→indicator backfill (plan §A7) and stays null
   * until then. FK enforced at the DB level (ON DELETE SET NULL) via the
   * migration; plain column to avoid cross-module relation coupling.
   */
  @Column({ name: 'syllabus_indicator_id', type: 'uuid', nullable: true })
  syllabusIndicatorId: string | null;

  /**
   * Shared stimulus FK for grouped past-paper items ("Use the table to
   * answer Questions 15 and 16"). Null for ordinary standalone questions.
   * Adjacent questions sharing the same stimulus_id render as one group
   * page on mobile.
   */
  @Column({ name: 'stimulus_id', type: 'uuid', nullable: true })
  stimulusId: string | null;

  @ManyToOne(() => QuestionStimulus, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'stimulus_id' })
  stimulus: QuestionStimulus | null;

  // v2: every question is scoped to a single exam platform. Never mix BECE + WASSCE.
  @Column({ name: 'exam_type', type: 'enum', enum: ExamType })
  examType: ExamType;

  @Column({
    name: 'question_type',
    type: 'enum',
    enum: QuestionType,
    default: QuestionType.MCQ,
  })
  questionType: QuestionType;

  @Column({
    type: 'enum',
    enum: QuestionSource,
    default: QuestionSource.WASSCE_PAST,
  })
  source: QuestionSource;

  @Column({ type: 'text' })
  body: string;

  @Column({ name: 'body_html', type: 'text', nullable: true })
  bodyHtml: string | null;

  @Column({ name: 'image_url', type: 'text', nullable: true })
  imageUrl: string | null;

  @Column({ type: 'int', nullable: true })
  year: number | null;

  @Column({ name: 'wassce_paper', type: 'int', nullable: true })
  wassecPaper: number | null;

  @Column({ type: 'varchar', length: 4, nullable: true })
  section: string | null;

  @Column({ type: 'enum', enum: Difficulty, default: Difficulty.MEDIUM })
  difficulty: Difficulty;

  @Column({ name: 'irt_difficulty', type: 'float', nullable: true })
  irtDifficulty: number | null;

  @Column({ type: 'text', array: true, default: () => 'ARRAY[]::text[]' })
  tags: string[];

  // v2: pre-generated AI explanation stored INLINE on the question record.
  // Generated once by admin bulk trigger; student tap = DB read only. Subscription
  // gating is enforced at the serialisation layer, not at row-level.
  @Column({ type: 'text', nullable: true })
  explanation: string | null;

  @Column({ name: 'explanation_html', type: 'text', nullable: true })
  explanationHtml: string | null;

  /**
   * Optional worked examples that supplement the `explanation`
   * paragraph. JSONB array of `WorkedExample` objects (see
   * ../types/worked-example.ts). NULL = render only the paragraph.
   * Set by manual admin import; the AI explanation generator only
   * writes the paragraph today.
   */
  @Column({ name: 'explanation_examples', type: 'jsonb', nullable: true })
  explanationExamples: WorkedExample[] | null;

  @Column({ name: 'explanation_model', type: 'text', nullable: true })
  explanationModel: string | null;

  @Column({
    name: 'explanation_generated_at',
    type: 'timestamptz',
    nullable: true,
  })
  explanationGeneratedAt: Date | null;

  @Column({
    type: 'enum',
    enum: QuestionStatus,
    default: QuestionStatus.ACTIVE,
  })
  status: QuestionStatus;

  @Column({ name: 'is_verified', type: 'bool', default: false })
  isVerified: boolean;

  @Column({ name: 'flag_count', type: 'int', default: 0 })
  flagCount: number;

  @Column({ name: 'times_answered', type: 'int', default: 0 })
  timesAnswered: number;

  @Column({ name: 'times_correct', type: 'int', default: 0 })
  timesCorrect: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => Option, (o) => o.question, { cascade: true })
  options: Option[];
}
