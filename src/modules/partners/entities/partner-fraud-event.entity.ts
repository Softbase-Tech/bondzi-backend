import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import {
  PartnerFraudEventType,
  PartnerFraudSeverity,
} from '../../../common/types/enums';
import { User } from '../../users/entities/user.entity';
import { Partner } from './partner.entity';

/**
 * Every triggered fraud check writes a row here. severity + type
 * drive the auto-block counter on `partners.fraud_flag_count`: when
 * high + medium events cross the threshold defined in the terms
 * version, the partner flips to `suspended` automatically.
 */
@Entity({ name: 'partner_fraud_events' })
export class PartnerFraudEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'partner_id', type: 'uuid' })
  partnerId: string;

  @ManyToOne(() => Partner, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'partner_id' })
  partner: Partner;

  @Column({
    type: 'enum',
    enum: PartnerFraudEventType,
    enumName: 'partner_fraud_event_type_enum',
  })
  type: PartnerFraudEventType;

  @Column({
    type: 'enum',
    enum: PartnerFraudSeverity,
    enumName: 'partner_fraud_severity_enum',
  })
  severity: PartnerFraudSeverity;

  @Column({ name: 'subject_ref', type: 'text', nullable: true })
  subjectRef: string | null;

  @Column({ type: 'text' })
  reason: string;

  @CreateDateColumn({ name: 'detected_at', type: 'timestamptz' })
  detectedAt: Date;

  @Column({ type: 'boolean', default: false })
  resolved: boolean;

  @Column({ name: 'resolved_by', type: 'uuid', nullable: true })
  resolvedBy: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'resolved_by' })
  resolvedByUser: User | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @Column({ name: 'resolution_note', type: 'text', nullable: true })
  resolutionNote: string | null;
}
