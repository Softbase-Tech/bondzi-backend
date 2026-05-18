import * as Joi from 'joi';

/**
 * Joi schema for required env vars. Server refuses to start if any required
 * var is missing or malformed — this is a [SEC] guarantee, not a convenience.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'staging', 'production')
    .default('development'),
  // WORKER_MODE gates both the BullMQ processors and the @Cron handlers
  // (each handler also re-checks the env at runtime). The previous shape
  // was a free-form string and a typo in the helm values (e.g. "True"
  // or "1") would silently make `=== 'true'` false, leaving the api
  // container to run every cron in parallel with the worker. Force a
  // small literal set so the typo fails at boot, not at 03:00 when the
  // leaderboard rollover double-fires.
  WORKER_MODE: Joi.string().valid('true', 'false').default('false'),
  PORT: Joi.number().port().default(3000),
  API_PREFIX: Joi.string().default('api/v1'),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  CORS_ORIGINS: Joi.string().default(''),

  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),
  DATABASE_SSL: Joi.boolean().default(false),
  DATABASE_LOGGING: Joi.boolean().default(false),
  DATABASE_POOL_MIN: Joi.number().integer().min(1).default(5),
  DATABASE_POOL_MAX: Joi.number().integer().min(1).default(20),

  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required(),
  REDIS_TLS: Joi.boolean().default(false),

  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_SECRET: Joi.string()
    .min(32)
    .required()
    .invalid(Joi.ref('JWT_ACCESS_SECRET')),
  JWT_ACCESS_EXPIRY: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRY: Joi.string().default('30d'),

  PAYSTACK_SECRET_KEY_GH: Joi.string().required(),
  PAYSTACK_PUBLIC_KEY_GH: Joi.string().required(),
  PAYSTACK_WEBHOOK_SECRET: Joi.string().required(),
  PAYSTACK_CALLBACK_URL: Joi.string().uri().required(),
  // After a plan price change, the previous plan stays resolvable for
  // this many hours so any open Paystack authorizationUrl can still
  // complete checkout against v1. Paystack's URL TTL is typically
  // ~24h; the default leaves plenty of headroom.
  CHECKOUT_GRACE_HOURS: Joi.number().integer().min(1).max(168).default(48),

  // AI — Bedrock-hosted Anthropic Claude. Auth is via the AWS SDK chain
  // (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY below, or an EC2/Lightsail
  // IAM role), so there's no per-provider API key to validate any more.
  // Legacy names AI_EXPLANATION_MODEL / AI_FAST_MODEL are kept as fallbacks
  // — ai.config.ts prefers AI_QUALITY_MODEL / AI_DEFAULT_MODEL.
  AI_QUALITY_MODEL: Joi.string().default(
    'anthropic.claude-sonnet-4-5-20250929-v1:0',
  ),
  AI_DEFAULT_MODEL: Joi.string().default(
    'anthropic.claude-haiku-4-5-20251001-v1:0',
  ),
  AI_EXPLANATION_MODEL: Joi.string().allow('').default(''),
  AI_FAST_MODEL: Joi.string().allow('').default(''),
  AI_DAILY_BUDGET_USD: Joi.number().positive().default(50),
  AI_PER_USER_DAILY_LIMIT: Joi.number().integer().positive().default(50),
  AI_MAX_JOB_COST_USD: Joi.number().positive().default(500),
  // Jobs whose estimated cost exceeds this threshold land in
  // PENDING_APPROVAL and require a SECOND admin to approve before
  // they're enqueued. Defends against a single compromised admin
  // session (or a typo'd filter selector) draining the AI budget in
  // one click. Set to 0 to disable co-sign entirely.
  AI_COSIGN_THRESHOLD_USD: Joi.number().min(0).default(50),
  AI_BEDROCK_MAX_RETRIES: Joi.number().integer().min(0).default(3),

  AT_USERNAME: Joi.string().required(),
  AT_API_KEY: Joi.string().required(),
  AT_SENDER_ID: Joi.string().default('BONDZI'),

  // AWS — required at boot in production for Bedrock + S3. Left optional in
  // the schema because dev / CI / Docker layers may not have them set and
  // the AWS SDK will fail loudly at the point of the first AWS call anyway.
  AWS_S3_BUCKET: Joi.string().allow('').default(''),
  AWS_ACCESS_KEY_ID: Joi.string().allow('').default(''),
  AWS_SECRET_ACCESS_KEY: Joi.string().allow('').default(''),
  AWS_REGION: Joi.string().default('eu-central-1'),
  AWS_S3_PUBLIC_BASE_URL: Joi.string().allow('').default(''),

  FIREBASE_PROJECT_ID: Joi.string().allow('').default(''),
  FIREBASE_PRIVATE_KEY: Joi.string().allow('').default(''),
  FIREBASE_CLIENT_EMAIL: Joi.string().allow('').default(''),

  SMTP_HOST: Joi.string().allow('').default(''),
  SMTP_PORT: Joi.number().port().default(587),
  SMTP_USER: Joi.string().allow('').default(''),
  SMTP_PASSWORD: Joi.string().allow('').default(''),
  SMTP_FROM: Joi.string().allow('').default(''),

  GOOGLE_CLIENT_ID: Joi.string().allow('').default(''),

  SENTRY_DSN: Joi.string().allow('').default(''),
  ADMIN_ALERT_EMAIL: Joi.string().email().default('admin@passmaster.com.gh'),

  SEED_ADMIN_EMAIL: Joi.string().email().default('admin@passmaster.com.gh'),
  // The dev default `change_me_strong_8+` passes Joi's `min(8)` and
  // would let a forgotten prod deploy boot with a literally-public
  // password (it's in this repo). In production we hard-fail at boot
  // unless an explicit value is set, AND we require at least 16 chars
  // since the default would otherwise be 19 anyway. Dev/test/staging
  // keep the convenient default so local boots Just Work.
  SEED_ADMIN_PASSWORD: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(16).required(),
    otherwise: Joi.string().min(8).default('change_me_strong_8+'),
  }),
  SEED_ADMIN_NAME: Joi.string().default('Platform Admin'),

  THROTTLE_SHORT_LIMIT: Joi.number().integer().positive().default(30),
  THROTTLE_SHORT_TTL: Joi.number().integer().positive().default(10),
  THROTTLE_LONG_LIMIT: Joi.number().integer().positive().default(200),
  THROTTLE_LONG_TTL: Joi.number().integer().positive().default(60),

  // SubscriptionGuard's Redis cache TTL in seconds. The guard reads the
  // subscriber's status from Redis on every protected request and falls
  // back to the DB on miss. Lower = less staleness after a cancel /
  // refund (a cancelled user keeps premium access for at most this
  // many seconds), higher = fewer DB hits on the protected path. 60s
  // is the sweet spot for an 8k-DAU service: ~5% of protected reads
  // hit the DB; cancellation impact ≤ 1 min.
  SUBSCRIPTION_STATUS_CACHE_TTL: Joi.number()
    .integer()
    .min(10)
    .max(600)
    .default(60),

  // Rewarded-ad XP path. Defaults OFF because the current implementation
  // would trust the client's "I watched an ad" call — without AdMob SSV
  // verification a curl loop could mint XP up to the daily frequency
  // cap. Only flip ON once `/ads/admob-ssv` (AdMob server-to-server) is
  // wired and the mobile no longer awards XP via the trust-client path.
  ADS_REWARDED_XP_ENABLED: Joi.boolean().default(false),

  // === Observability ===
  // All fields are optional with safe defaults so dev / CI / staging keep
  // working without any external setup. In prod we set LOKI_URL +
  // LOKI_USER + LOKI_API_KEY to enable shipping to Grafana Cloud Loki;
  // unset means logs only go to stdout.
  LOG_LEVEL: Joi.string()
    .valid('trace', 'debug', 'info', 'warn', 'error', 'fatal')
    .default('info'),
  LOKI_URL: Joi.string().uri().allow('').default(''),
  LOKI_USER: Joi.string().allow('').default(''),
  LOKI_API_KEY: Joi.string().allow('').default(''),
  // /api/v1/internal/metrics is locked behind a static bearer token AND
  // (separately) an nginx IP allowlist. Enabled by default in non-test
  // envs; the token only needs to be set in prod.
  METRICS_ENABLED: Joi.boolean().default(true),
  METRICS_BEARER_TOKEN: Joi.string().allow('').default(''),
});
