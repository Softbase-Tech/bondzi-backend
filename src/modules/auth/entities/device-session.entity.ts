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
 * Per-device session enforcement. At most one row per
 * (user, device_id). A student can be signed in on multiple devices
 * concurrently (web + mobile + tablet) without the newest login
 * kicking the others out. Each device's row rotates independently
 * on refresh; a re-login for the same (user, device_id) UPSERTs and
 * rotates that device's row only.
 *
 * DEVICE_KICKED is now issued strictly when a refresh token's
 * `(user_id, device_id)` no longer resolves to a session row —
 * either because that specific device was logged out, or because
 * the user's password was reset (which nukes every session, via
 * logoutAll).
 */
@Entity({ name: 'device_sessions' })
@Index('idx_device_sessions_user_device', ['userId', 'deviceId'], {
  unique: true,
})
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

  /**
   * Refresh-token rotation forensics (#98). Each successful rotate()
   * bumps rotation_count and stamps last_rotated_at + last_rotation_ip.
   * Defaults are 0/null on a fresh issuePair so a brand-new session
   * doesn't claim a rotation.
   *
   * Why: a healthy session refreshes on a predictable cadence (every
   * ~15min while the app is open) from a stable IP. An attacker who
   * steals a refresh token will rotate from a different IP — and the
   * RIGHTFUL owner's next rotation will also rotate, racing back and
   * forth. Persisting the rotation history makes "is this device-swap
   * or token theft?" answerable from audit forensics instead of "we
   * have no idea."
   */
  @Column({ name: 'rotation_count', type: 'int', default: 0 })
  rotationCount: number;

  @Column({ name: 'last_rotated_at', type: 'timestamptz', nullable: true })
  lastRotatedAt: Date | null;

  @Column({ name: 'last_rotation_ip', type: 'text', nullable: true })
  lastRotationIp: string | null;

  /**
   * Refresh-token rotation grace.
   *
   * On every rotate(), the OUTGOING (about-to-be-replaced)
   * refresh-token JTI is stashed here and `previous_jti_expires_at` is
   * set REFRESH_TOKEN_GRACE_MS in the future. If the CURRENT jti check
   * fails on the next refresh, we fall back to the previous jti — as
   * long as we're still inside the grace window — and issue a fresh
   * pair as if the current one had been used.
   *
   * Why: the mobile client can lose the newly-minted pair without ever
   * persisting it (app force-killed mid-response, TCP reset after the
   * server rotated but before the body reached the phone, cellular
   * flap that drops the response, etc.). Without grace, that client is
   * one race away from DEVICE_KICKED with no recourse but "sign in
   * again" — and the user experiences it as "the app kicks me out for
   * no reason." A short grace fixes the honest cases without meaningful
   * cost to the single-device guarantee: an attacker still gets only
   * REFRESH_TOKEN_GRACE_MS to use a stolen refresh-token before the
   * rightful owner's next rotate expires the grace window.
   */
  @Column({ name: 'previous_refresh_jti', type: 'text', nullable: true })
  previousRefreshJti: string | null;

  @Column({
    name: 'previous_jti_expires_at',
    type: 'timestamptz',
    nullable: true,
  })
  previousJtiExpiresAt: Date | null;
}
