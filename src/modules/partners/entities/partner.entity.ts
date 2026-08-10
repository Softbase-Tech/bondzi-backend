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
import { MomoProvider, PartnerStatus } from '../../../common/types/enums';
import { User } from '../../users/entities/user.entity';
import { PartnerTermsVersion } from './partner-terms-version.entity';

/**
 * Partner identity row. `user_id` is nullable so partner-only
 * accounts (no student account) can be supported in a later phase.
 * When set, the partner shares credentials with the student account —
 * they authenticate through the same /auth/login and are gated
 * onto /partner/* endpoints by PartnerAuthGuard checking for this
 * row.
 *
 * Status flow: `pending → active` (admin approves) OR
 * `pending → suspended → banned` (fraud). Suspended partners can
 * open appeals; three denied appeals → banned.
 */
@Entity({ name: 'partners' })
@Index('idx_partners_status', ['status'])
export class Partner {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ type: 'text' })
  email: string;

  @Column({ type: 'text' })
  phone: string;

  @Column({ name: 'full_name', type: 'text' })
  fullName: string;

  @Column({ name: 'country_code', type: 'text', default: 'GH' })
  countryCode: string;

  @Column({
    name: 'momo_provider',
    type: 'enum',
    enum: MomoProvider,
    enumName: 'momo_provider_enum',
  })
  momoProvider: MomoProvider;

  @Column({ name: 'momo_number', type: 'text' })
  momoNumber: string;

  @Column({ name: 'momo_account_name', type: 'text' })
  momoAccountName: string;

  @Column({
    type: 'enum',
    enum: PartnerStatus,
    enumName: 'partner_status_enum',
    default: PartnerStatus.PENDING,
  })
  status: PartnerStatus;

  @Column({ name: 'agreed_terms_version_id', type: 'uuid' })
  agreedTermsVersionId: string;

  @ManyToOne(() => PartnerTermsVersion, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'agreed_terms_version_id' })
  agreedTermsVersion: PartnerTermsVersion;

  @Column({ name: 'fraud_flag_count', type: 'int', default: 0 })
  fraudFlagCount: number;

  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  @Column({ name: 'approved_by', type: 'uuid', nullable: true })
  approvedBy: string | null;

  @Column({ name: 'suspended_at', type: 'timestamptz', nullable: true })
  suspendedAt: Date | null;

  @Column({ name: 'banned_at', type: 'timestamptz', nullable: true })
  bannedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
