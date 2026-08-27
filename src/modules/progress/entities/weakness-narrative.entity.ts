import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

/**
 * One AI-generated weakness narrative per (user, day, subject_scope).
 * `subject_scope` is either a subject uuid or the string 'all' for a
 * cross-subject narrative. Persisted so a same-day re-fetch doesn't
 * burn another Bedrock call (or consume another AI_WEAKNESS_NARRATIVES
 * quota point).
 */
@Entity({ name: 'weakness_narratives' })
@Index('idx_weakness_narratives_day', ['day'])
export class WeaknessNarrative {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @PrimaryColumn({ type: 'date' })
  day: string;

  @PrimaryColumn({ name: 'subject_scope', type: 'text' })
  subjectScope: string;

  @Column({ type: 'text' })
  narrative: string;

  /**
   * How this row was produced. `bootstrap` rows have canned prose and
   * did NOT cost a Bedrock call or entitlement point; the Home card
   * uses this to decide whether to render at all.
   */
  @Column({ type: 'text', default: 'personalised' })
  mode: 'bootstrap' | 'personalised';

  @Column({ type: 'text' })
  model: string;

  /**
   * Machine-readable actions the app renders as deep links
   * ("Read now" / "Practice 5 questions") — premium plan §6.3.
   * Null on bootstrap rows and rows generated before v2.
   */
  @Column({ type: 'jsonb', nullable: true })
  recommendations: StudentRecommendation[] | null;

  @CreateDateColumn({ name: 'generated_at', type: 'timestamptz' })
  generatedAt: Date;
}

export interface StudentRecommendation {
  syllabusTopicId: string;
  action: 'read' | 'practice';
  /** Present when action='read' — a learning_material_chunks id. */
  chunkId?: string;
  /** Human label, e.g. "Vectors and Scalars — Key Ideas (p. 41)". */
  label?: string;
  /** Present when action='practice'. */
  count?: number;
}
