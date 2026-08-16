import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One FAQ Q&A pair. Answers ship as markdown so the admin editor can
 * emit bullet lists, bold, links and paragraph breaks without a
 * per-field schema change; the mobile MathMarkdown component renders
 * the same shape it uses for question stems and AI-review reports.
 *
 * `slug` is the stable identifier the mobile deep-links to
 * (/help/faq/:slug) and the value we key `on conflict` upserts by
 * during seed. Never recycle a slug — a live share link out in the
 * wild that lands on a semantically-different answer is worse than
 * a "retired" state.
 */
@Entity('faq_entries')
@Index('idx_faq_active_sort', ['isActive', 'sortOrder'])
export class FaqEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text', unique: true })
  slug: string;

  @Column({ type: 'text' })
  question: string;

  @Column({ name: 'answer_markdown', type: 'text' })
  answerMarkdown: string;

  /**
   * Lower value renders further up the list. Non-unique — the seed
   * places the top-volume support questions first (10, 20, …). When
   * two rows tie the DB falls back to `created_at` which is
   * deterministic enough for admin UX.
   */
  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  /**
   * `false` retires the entry — hidden from mobile, kept for the
   * admin. Soft-deletion so a deep link out in the wild degrades
   * to a "retired" surface rather than a 404.
   */
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
