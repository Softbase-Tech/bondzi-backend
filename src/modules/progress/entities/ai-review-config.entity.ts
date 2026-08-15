import {
  Column,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Single-row admin config for AI Study Review monthly limits. Follows
 * the ad_config pattern: one row, edited from the admin dashboard via
 * GET/PATCH /admin/config/ai-reviews.
 *
 * Free tier is intentionally NOT represented — Free users cannot
 * generate reviews at all (the card shows an upgrade CTA), so there is
 * no limit to tune. Only Plus and Pro have monthly allowances.
 *
 * Limits are per-Accra-calendar-month and do NOT carry forward: unused
 * generations at month-end are lost, and the counter resets purely by
 * the review rows falling outside the new month window.
 */
@Entity({ name: 'ai_review_config' })
export class AiReviewConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'plus_monthly_limit', type: 'int', default: 10 })
  plusMonthlyLimit: number;

  @Column({ name: 'pro_monthly_limit', type: 'int', default: 30 })
  proMonthlyLimit: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
