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
import { PartnerBannerAspect } from '../../../common/types/enums';
import { User } from '../../users/entities/user.entity';

/**
 * A single shareable banner asset shown in the partner portal
 * gallery. `image_url` is the CDN URL of the artwork; we don't own
 * the bytes here — admin uploads to Cloudinary/S3 and pastes the URL.
 *
 * `aspect` shapes the gallery card so a story-format image doesn't
 * get squashed into a square tile. `width_px` / `height_px` are
 * optional annotations displayed on the partner side so they can
 * see the intended target platform.
 *
 * `sort_order` + `is_active` control what partners see; deactivating
 * a banner keeps the row for audit but hides it from the gallery.
 */
@Entity({ name: 'partner_banners' })
@Index('idx_partner_banners_active_sort', ['isActive', 'sortOrder'])
export class PartnerBanner {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  label: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'image_url', type: 'text' })
  imageUrl: string;

  @Column({
    type: 'enum',
    enum: PartnerBannerAspect,
    enumName: 'partner_banner_aspect_enum',
    default: PartnerBannerAspect.SQUARE,
  })
  aspect: PartnerBannerAspect;

  @Column({ name: 'width_px', type: 'int', nullable: true })
  widthPx: number | null;

  @Column({ name: 'height_px', type: 'int', nullable: true })
  heightPx: number | null;

  @Column({ name: 'sort_order', type: 'int', default: 100 })
  sortOrder: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

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
