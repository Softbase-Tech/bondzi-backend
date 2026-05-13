import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * v2 single-device enforcement. At most one row per user. New login deletes any
 * existing row; refresh token use updates last_seen_at; logout deletes the row.
 * Kicked sessions return DEVICE_KICKED on refresh to distinguish from generic
 * expiry.
 */
@Entity({ name: 'device_sessions' })
@Index('idx_device_sessions_user', ['userId'], { unique: true })
export class DeviceSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'device_id', type: 'text' })
  deviceId: string;

  @Column({ name: 'device_name', type: 'text', nullable: true })
  deviceName: string | null;

  @Column({ name: 'refresh_token_jti', type: 'text', unique: true })
  refreshTokenJti: string;

  @Column({ name: 'ip_address', type: 'text', nullable: true })
  ipAddress: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({
    name: 'last_seen_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  lastSeenAt: Date;
}
