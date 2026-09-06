import {
  Column,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export interface WebAdPlacement {
  enabled: boolean;
  slotId: string;
  /** blog_inline only: insert after the Nth top-level content block. */
  afterBlock?: number;
}

export interface WebAdsConfig {
  enabled?: boolean;
  publisherId?: string;
  placements?: Record<string, WebAdPlacement>;
}

/**
 * v2 Phase 2 ads config. One row — admin toggles `adsEnabled` to go live. Only
 * free-tier students ever hit the ads endpoints; subscribers skip entirely.
 * `web_ads` carries the website AdSense side (blog first).
 */
@Entity({ name: 'ad_config' })
export class AdConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'ads_enabled', type: 'bool', default: false })
  adsEnabled: boolean;

  @Column({ name: 'ad_network', type: 'text', default: 'admob' })
  adNetwork: string;

  @Column({ name: 'admob_app_id', type: 'text', nullable: true })
  admobAppId: string | null;

  @Column({ name: 'admob_interstitial_id', type: 'text', nullable: true })
  admobInterstitialId: string | null;

  @Column({ name: 'admob_rewarded_id', type: 'text', nullable: true })
  admobRewardedId: string | null;

  @Column({ name: 'rewarded_xp_amount', type: 'int', default: 5 })
  rewardedXpAmount: number;

  @Column({ name: 'frequency_cap', type: 'int', default: 3 })
  frequencyCap: number;

  @Column({ name: 'trigger_event', type: 'text', default: 'exam_complete' })
  triggerEvent: string;

  /**
   * Website AdSense config (blog/landing/web-app placements). Shape:
   * { enabled, publisherId, placements: { <key>: { enabled, slotId,
   * afterBlock? } } }. jsonb so placements can grow without
   * migrations; the admin UI is the schema's source of truth.
   */
  @Column({ name: 'web_ads', type: 'jsonb', default: () => "'{}'::jsonb" })
  webAds: WebAdsConfig;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
