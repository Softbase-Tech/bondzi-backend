import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Append-only login history: one row per successful auth artifact issuance
 * that represents a real sign-in (register / password login / Google / OTP),
 * recording the platform it came from. Distinct from `device_sessions`, which
 * is a live-session table (upserted, rows removed on logout) — this table is
 * never mutated, so it's a durable record of "which platform did they log in
 * from, and when." Refresh-token rotations are NOT recorded here.
 */
@Entity('auth_login_events')
@Index('idx_auth_login_events_user', ['userId', 'createdAt'])
export class AuthLoginEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  /** 'web' | 'ios' | 'android', or null when the client sent no X-Platform. */
  @Column({ type: 'text', nullable: true })
  platform: string | null;

  /** How the session was established: 'register' | 'login' | 'google' | 'otp'. */
  @Column({ name: 'event_type', type: 'text' })
  eventType: string;

  @Column({ name: 'device_id', type: 'text', nullable: true })
  deviceId: string | null;

  @Column({ name: 'ip_address', type: 'text', nullable: true })
  ipAddress: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
