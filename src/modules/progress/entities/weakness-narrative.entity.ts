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

  @Column({ type: 'text' })
  model: string;

  @CreateDateColumn({ name: 'generated_at', type: 'timestamptz' })
  generatedAt: Date;
}
