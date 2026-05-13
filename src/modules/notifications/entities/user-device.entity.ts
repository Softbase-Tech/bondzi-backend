import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum DevicePlatform {
  IOS = 'ios',
  ANDROID = 'android',
  WEB = 'web',
}

@Entity({ name: 'user_devices' })
@Index('idx_user_devices_user', ['userId'])
@Index('idx_user_devices_token', ['fcmToken'])
@Unique('uq_user_devices_user_token', ['userId', 'fcmToken'])
export class UserDevice {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'enum', enum: DevicePlatform })
  platform: DevicePlatform;

  @Column({ name: 'fcm_token', type: 'text' })
  fcmToken: string;

  @Column({ name: 'device_id', type: 'text', nullable: true })
  deviceId: string | null;

  @Column({ name: 'app_version', type: 'text', nullable: true })
  appVersion: string | null;

  @Column({ name: 'last_seen_at', type: 'timestamptz' })
  lastSeenAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
