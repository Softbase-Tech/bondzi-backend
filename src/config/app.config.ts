import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  apiPrefix: process.env.API_PREFIX ?? 'api/v1',
  appUrl: process.env.APP_URL ?? 'http://localhost:3000',
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  sentryDsn: process.env.SENTRY_DSN ?? '',
  adminAlertEmail: process.env.ADMIN_ALERT_EMAIL ?? '',
  // Rewarded-ad XP — defaults OFF until AdMob SSV is wired. See
  // validation.schema.ts for the full rationale.
  adsRewardedXpEnabled:
    (process.env.ADS_REWARDED_XP_ENABLED ?? 'false').toLowerCase() === 'true',
  // SubscriptionGuard cache TTL in seconds. Lower bound is the staleness
  // window after a cancel/refund (a recently-refunded user can still
  // pass the guard for up to this many seconds before the next cache
  // miss re-reads the DB). 60s is the default.
  subscriptionStatusCacheTtlSec: parseInt(
    process.env.SUBSCRIPTION_STATUS_CACHE_TTL ?? '60',
    10,
  ),
}));
