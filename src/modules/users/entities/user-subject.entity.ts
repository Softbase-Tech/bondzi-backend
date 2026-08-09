import {
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from './user.entity';
import { Subject } from '../../subjects/entities/subject.entity';

/**
 * Per-user subject selection. See `1890-UserSubjects` migration for the
 * intent + soft-filter contract. The (user_id, subject_id) composite PK
 * is the natural key — we never insert duplicate selections, and a
 * fresh selection wholesale-replaces via `delete + bulk insert` inside
 * a transaction (see `setSelectedSubjects`).
 */
@Entity({ name: 'user_subjects' })
export class UserSubject {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @PrimaryColumn({ name: 'subject_id', type: 'uuid' })
  subjectId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Subject, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'subject_id' })
  subject: Subject;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
