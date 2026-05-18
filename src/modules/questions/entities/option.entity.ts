import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Exclude } from 'class-transformer';
import { Question } from './question.entity';

/**
 * Answer option for an MCQ question.
 *
 * [SEC] isCorrect MUST NEVER leak to a student response. The OptionStudentDto
 * in ../dto/option-student.dto.ts is the only shape returned before an
 * answer is submitted. `@Exclude()` below is a belt-and-suspenders —
 * services never construct raw Option JSON for students.
 */
@Entity({ name: 'options' })
@Index('idx_options_question', ['questionId'])
export class Option {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'question_id', type: 'uuid' })
  questionId: string;

  @ManyToOne(() => Question, (q) => q.options, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'question_id' })
  question: Question;

  @Column({ type: 'varchar', length: 2 })
  label: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ name: 'body_html', type: 'text', nullable: true })
  bodyHtml: string | null;

  @Column({ name: 'image_url', type: 'text', nullable: true })
  imageUrl: string | null;

  @Exclude()
  @Column({ name: 'is_correct', type: 'bool', default: false })
  isCorrect: boolean;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
