import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  AuthProvider,
  ExamType,
  Gender,
  SchoolLevel,
  UserRole,
} from '../../../common/types/enums';

@Entity({ name: 'users' })
@Index('users_email_idx', ['email'])
@Index('users_phone_idx', ['phone'])
@Index('idx_users_exam_type', ['examType'])
@Index('idx_users_referral', ['referralCode'])
@Index('idx_users_referred_by', ['referredBy'])
@Index('idx_users_active', ['isActive', 'deletedAt'])
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'full_name', type: 'text' })
  fullName: string;

  // Public handle used on leaderboards / Hall of Fame / referrals.
  // Nullable for accounts predating migration 1940 — the mobile client
  // forces a back-fill modal on first session post-deploy so they're
  // populated organically. Uniqueness enforced case-insensitively via
  // a partial unique index on `lower(username)`, not at the column
  // level — see 1940000000000-AddUsername.ts.
  @Column({ type: 'text', nullable: true })
  username: string | null;

  // Powers the 90-day "username can only change once per quarter"
  // cooldown. NULL means never set; first-time back-fill is free, the
  // window starts ticking on that first save.
  @Column({ name: 'username_changed_at', type: 'timestamptz', nullable: true })
  usernameChangedAt: Date | null;

  @Column({ type: 'text', unique: true, nullable: true })
  email: string | null;

  @Column({ type: 'text', unique: true, nullable: true })
  phone: string | null;

  // select: false — never leaks in queries by default. Explicitly
  // .addSelect('user.passwordHash') in the auth service when verifying.
  @Column({
    name: 'password_hash',
    type: 'text',
    nullable: true,
    select: false,
  })
  passwordHash: string | null;

  @Column({
    name: 'auth_provider',
    type: 'enum',
    enum: AuthProvider,
    default: AuthProvider.EMAIL,
  })
  authProvider: AuthProvider;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.STUDENT })
  role: UserRole;

  // v2: exam identity set at registration, changeable via settings.
  @Column({ name: 'exam_type', type: 'enum', enum: ExamType })
  examType: ExamType;

  @Column({ name: 'school_level', type: 'enum', enum: SchoolLevel })
  schoolLevel: SchoolLevel;

  // form_level: 1-3 for both JHS and SHS. Meaning depends on school_level.
  // NULL for `remedial` users (NOVDEC re-sit candidates) — they're not in a
  // school cohort so form-level has no meaning. Subject-filter queries that
  // join on form_level must coalesce / branch on school_level = 'remedial'.
  @Column({ name: 'form_level', type: 'int', nullable: true })
  formLevel: number | null;

  @Column({ name: 'school_name', type: 'text', nullable: true })
  schoolName: string | null;

  @Column({ type: 'text', nullable: true })
  region: string | null;

  // Collected at registration going forward. Nullable to keep accounts
  // created before migration 1930 functional — they continue to work
  // and can fill these via Settings → Account later if we add the UI.
  @Column({ type: 'enum', enum: Gender, nullable: true })
  gender: Gender | null;

  // Stored as `date` (no time component, no timezone). Validation at
  // the DTO layer enforces sensible bounds (≥ 8 years old, in the
  // past). Always nullable at the DB layer for the same backwards-compat
  // reason as `gender`.
  @Column({ name: 'date_of_birth', type: 'date', nullable: true })
  dateOfBirth: string | null;

  // Student-confirmed date of their next exam sitting. Optional — when
  // NULL the mobile profile card renders the "no exam date set" state
  // with a "Set exam date" CTA. When set, the card shows a real
  // countdown instead of the client-side heuristic (May 15 WASSCE,
  // June 15 BECE, Oct 15 NOVDEC). Stored as `date` (no time, no zone)
  // for the same reasons as `date_of_birth`.
  @Column({ name: 'target_exam_date', type: 'date', nullable: true })
  targetExamDate: string | null;

  @Column({ name: 'avatar_url', type: 'text', nullable: true })
  avatarUrl: string | null;

  @Column({ name: 'is_active', type: 'bool', default: true })
  isActive: boolean;

  // v2: referral — every user has a unique code, generated at registration.
  @Column({ name: 'referral_code', type: 'text', unique: true })
  referralCode: string;

  @Column({ name: 'referred_by', type: 'uuid', nullable: true })
  referredBy: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'referred_by' })
  referrer: User | null;

  // true after the referred user answers 10 questions.
  @Column({ name: 'referral_qualified', type: 'bool', default: false })
  referralQualified: boolean;

  // v2: two XP pools.
  // level_xp: total earned, never decreases, drives level-up.
  // spendable_xp: earned AND redeemable (redemption subtracts from this only).
  @Column({ name: 'level_xp', type: 'bigint', default: 0 })
  levelXp: string;

  @Column({ name: 'spendable_xp', type: 'bigint', default: 0 })
  spendableXp: string;

  @Column({ name: 'current_level', type: 'int', default: 1 })
  currentLevel: number;

  // v2: streak tracking (was previously derived/computed).
  @Column({ name: 'streak_days', type: 'int', default: 0 })
  streakDays: number;

  @Column({ name: 'longest_streak', type: 'int', default: 0 })
  longestStreak: number;

  @Column({ name: 'last_study_date', type: 'date', nullable: true })
  lastStudyDate: string | null;

  // v2: single-device enforcement. Client-generated fingerprint, persisted in
  // SecureStorage. Kept in sync with device_sessions.device_id on every login.
  @Column({ name: 'current_device_id', type: 'text', nullable: true })
  currentDeviceId: string | null;

  @Column({ name: 'country_code', type: 'varchar', length: 2, default: 'GH' })
  countryCode: string;

  /**
   * Platform the account was created from — 'web' (browser app) or
   * 'ios'/'android' (mobile app). Set once at registration from the
   * X-Platform header; null for legacy rows / clients that don't send it.
   */
  @Column({ name: 'signup_platform', type: 'text', nullable: true })
  signupPlatform: string | null;

  @Column({ name: 'last_active_at', type: 'timestamptz', nullable: true })
  lastActiveAt: Date | null;

  @Column({ name: 'email_verified_at', type: 'timestamptz', nullable: true })
  emailVerifiedAt: Date | null;

  @Column({ name: 'email_bounced_at', type: 'timestamptz', nullable: true })
  emailBouncedAt: Date | null;

  @Column({ name: 'email_unsubscribe_token', type: 'text', nullable: true })
  emailUnsubscribeToken: string | null;

  @Column({ name: 'email_weekly_digest_enabled', type: 'bool', default: true })
  emailWeeklyDigestEnabled: boolean;

  @Column({ name: 'email_streak_nudges_enabled', type: 'bool', default: true })
  emailStreakNudgesEnabled: boolean;

  @Column({ name: 'email_level_up_enabled', type: 'bool', default: true })
  emailLevelUpEnabled: boolean;

  @Column({ name: 'email_marketing_enabled', type: 'bool', default: true })
  emailMarketingEnabled: boolean;

  /**
   * Daily-reminder + weekly-leaderboard push notifications. Users can
   * mute the routine cadence via /settings/notifications without also
   * muting streak nudges (below).
   */
  @Column({ name: 'push_reminders_enabled', type: 'bool', default: true })
  pushRemindersEnabled: boolean;

  /**
   * 17:00 "streak at risk" push. Separate flag from the routine
   * reminders because streak nudges are urgency-driven — users often
   * want THIS even when they've muted the daily reminder.
   */
  @Column({ name: 'push_streak_nudges_enabled', type: 'bool', default: true })
  pushStreakNudgesEnabled: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
