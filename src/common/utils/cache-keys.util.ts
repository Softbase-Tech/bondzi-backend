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
  loginAttempts: (ipOrIdentifier: string) => `login_attempts:${ipOrIdentifier}`,
  refreshToken: (jti: string) => `refresh_token:${jti}`,
  revokedJti: (jti: string) => `revoked_jti:${jti}`,
  refreshFamily: (familyId: string) => `refresh_family:${familyId}`,
  /**
   * The deviceId currently bound to `device_sessions(user_id)`. Used by
   * JwtStrategy to reject access tokens whose `did` claim no longer
   * matches the active session — closes the "DEVICE_KICKED token survives
   * 15 minutes" hole.
   */
  activeDeviceId: (userId: string) => `active_device:${userId}`,
  aiCostDay: (date: string) => `ai_cost:day:${date}`,
  aiCostUserDay: (userId: string, date: string) =>
    `ai_cost:user:${userId}:${date}`,
  aiUserDailyCalls: (userId: string, date: string) =>
    `ai_calls:user:${userId}:${date}`,
} as const;
