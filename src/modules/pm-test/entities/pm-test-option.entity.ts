import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { PmTestQuestion } from './pm-test-question.entity';

@Entity({ name: 'pm_test_options' })
@Index('idx_pm_test_options_question', ['questionId'])
export class PmTestOption {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'question_id', type: 'uuid' })
  questionId: string;

  @ManyToOne(() => PmTestQuestion, (q) => q.options, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'question_id' })
  question: PmTestQuestion;

  @Column({ type: 'text' })
  label: string;

  @Column({ type: 'text' })
  body: string;

  // NEVER exposed to students pre-answer. Stripped at the serialisation layer.
  @Column({ name: 'is_correct', type: 'bool', default: false })
  isCorrect: boolean;
}
