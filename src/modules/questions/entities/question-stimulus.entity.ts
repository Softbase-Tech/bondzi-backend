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
import { User } from '../../users/entities/user.entity';

/**
 * Shared context block referenced by 2+ questions in past-paper grouped
 * items ("Use the table below to answer Questions 15 and 16"). One row
 * per shared block; the question.stimulus_id FK is what links them.
 *
 * `body` is markdown (with `$...$` LaTeX math). `body_html` is the
 * pre-rendered HTML — the same pipeline used on Question.body. Keeping
 * both lets the admin web app render it instantly without re-running
 * the markdown pipeline, while the mobile reads the markdown directly
 * (its renderer inlines SVG math at serialise time).
 */
@Entity({ name: 'question_stimuli' })
@Index('idx_question_stimuli_created_at', ['createdAt'])
export class QuestionStimulus {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Optional short label used in the admin picker (e.g. "Temperatures table"). */
  @Column({ type: 'text', nullable: true })
  title: string | null;

  @Column({ type: 'text' })
  body: string;

  @Column({ name: 'body_html', type: 'text', nullable: true })
  bodyHtml: string | null;

  @Column({ name: 'image_url', type: 'text', nullable: true })
  imageUrl: string | null;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by' })
  createdByUser: User | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
