import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { PartnerAppealStatus } from '../../../common/types/enums';
import { User } from '../../users/entities/user.entity';
import { Partner } from './partner.entity';

/**
 * Bounded appeals. Each partner can open at most 3 appeals (checked
 * by the DB constraint on appeal_number IN (1,2,3) and the UNIQUE
 * (partner_id, appeal_number) index). A third denied appeal flips
 * the partner to `banned` in PartnersService.
 */
@Entity({ name: 'partner_appeals' })
@Unique('idx_partner_appeals_pn', ['partnerId', 'appealNumber'])
export class PartnerAppeal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'partner_id', type: 'uuid' })
  partnerId: string;

  @ManyToOne(() => Partner, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'partner_id' })
  partner: Partner;

  @Column({ name: 'appeal_number', type: 'int' })
  appealNumber: number;

  @CreateDateColumn({ name: 'opened_at', type: 'timestamptz' })
  openedAt: Date;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'text', array: true, default: '{}' })
  attachments: string[];

  @Column({
    type: 'enum',
    enum: PartnerAppealStatus,
    enumName: 'partner_appeal_status_enum',
    default: PartnerAppealStatus.OPEN,
  })
  status: PartnerAppealStatus;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @Column({ name: 'resolved_by', type: 'uuid', nullable: true })
  resolvedBy: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'resolved_by' })
  resolvedByUser: User | null;

  @Column({ name: 'resolution_note', type: 'text', nullable: true })
  resolutionNote: string | null;
}
