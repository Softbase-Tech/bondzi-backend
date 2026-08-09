/**
 * Centralised Redis key registry. Every cache key used anywhere in the system
 * must be minted by one of these helpers — never build keys inline.
 *
 * Key naming: namespaced by domain, colon-delimited, lower-case.
 */
export const CacheKeys = {
  subjectsAll: () => 'subjects:all',
  subject: (id: string) => `subject:${id}`,
  // Spec §3.1: past_paper:{examType}:{subjectId}:{year}:{paper}. examType is
  // mandatory on the endpoint so it's mandatory here too.
  pastPaper: (
    examType: string,
    subjectId: string,
    year: number,
    paper?: number,
  ) => `past_paper:${examType}:${subjectId}:${year}:${paper ?? 'all'}`,
  explanation: (questionId: string, promptVersion: string) =>
    `explanation:${questionId}:${promptVersion}`,
  pendingExplanation: (userId: string, questionId: string) =>
    `pending_explanation:${userId}:${questionId}`,
  subscriptionStatus: (userId: string) => `subscription_status:${userId}`,
  /**
   * Per-(user, level) entitlement cache. Stores the resolved `{ account,
   * expiresAt, subscriptionId }` for the user on a given exam level. Plus
   * is per-level (lifetime), Pro is per-level (recurring) — so a single
   * userId can have three different entitlement values, one per level.
   * Invalidated on payment success / cancel / refund via
   * SubscriptionsService.invalidateEntitlementCache(userId).
   */
  entitlement: (userId: string, level: string) =>
    `entitlement:${userId}:${level}`,
  leaderboardWeekly: (week: string) => `leaderboard:weekly:${week}`,
  userStats: (userId: string) => `user_stats:${userId}`,
  srsDueCount: (userId: string) => `srs_due_count:${userId}`,
  otp: (phone: string) => `otp:${phone}`,
  otpRateLimit: (phone: string) => `otp_rate:${phone}`,
  /**
   * Email OTP — pre-registration verification. Keyed by the
   * lowercased email so casing variations can't be used to bypass
   * the send-throttle bucket.
   */
  emailOtp: (email: string) => `email_otp:${email.toLowerCase()}`,
  emailOtpRateLimit: (email: string) => `email_otp_rate:${email.toLowerCase()}`,
  loginAttempts: (ipOrIdentifier: string) => `login_attempts:${ipOrIdentifier}`,
  refreshToken: (jti: string) => `refresh_token:${jti}`,
  revokedJti: (jti: string) => `revoked_jti:${jti}`,
  refreshFamily: (familyId: string) => `refresh_family:${familyId}`,
  /**
   * Per-(user, device) session marker. Set on login/refresh, deleted
   * on logout / logout-all. JwtStrategy checks presence to reject
   * access tokens for signed-out devices without a DB round-trip —
   * a per-device key (rather than a single per-user value) means a
   * logout on device A never affects device B's marker.
   */
  activeDeviceId: (userId: string, deviceId: string) =>
    `active_device:${userId}:${deviceId}`,
  aiCostDay: (date: string) => `ai_cost:day:${date}`,
  aiCostUserDay: (userId: string, date: string) =>
    `ai_cost:user:${userId}:${date}`,
  aiUserDailyCalls: (userId: string, date: string) =>
    `ai_calls:user:${userId}:${date}`,
  // emailVerifyToken / passwordResetToken cache-key helpers were
  // retired when both flows moved to email OTP codes. Codes live under
  // CacheKeys.emailOtp with a purpose-namespaced suffix (see
  // OtpService.emailOtpKey).
  forgotPasswordRate: (email: string) =>
    `forgot_password:${email.toLowerCase()}`,
} as const;
