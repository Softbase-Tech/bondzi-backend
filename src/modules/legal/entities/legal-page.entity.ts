import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * Admin-editable static document. Each row is one logical page —
 * `slug` is the public identifier the mobile / web client fetches by
 * (e.g. 'refund-policy', 'terms', 'privacy').
 *
 * Body is plain Markdown. We don't sanitise at write time because the
 * controller is admin-only; the renderer (mobile) sanitises on display.
 * Schema is defined in migration 1860 — this entity mirrors that table.
 */
@Entity({ name: 'legal_pages' })
export class LegalPage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text', unique: true })
  slug: string;

  @Column({ type: 'text' })
  title: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'updated_by' })
  updatedByUser: User | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
