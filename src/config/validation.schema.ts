import * as Joi from 'joi';

/**
 * Joi schema for required env vars. Server refuses to start if any required
 * var is missing or malformed — this is a [SEC] guarantee, not a convenience.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'staging', 'production')
    .default('development'),
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

  ANTHROPIC_API_KEY: Joi.string().required(),
  OPENAI_API_KEY: Joi.string().required(),
  AI_EXPLANATION_MODEL: Joi.string().default('claude-sonnet-4-6'),
  AI_FAST_MODEL: Joi.string().default('claude-haiku-4-5-20251001'),
  AI_FAILOVER_MODEL: Joi.string().default('gpt-4o-mini'),
  AI_DAILY_BUDGET_USD: Joi.number().positive().default(50),
  AI_PER_USER_DAILY_LIMIT: Joi.number().integer().positive().default(50),

  AT_USERNAME: Joi.string().required(),
  AT_API_KEY: Joi.string().required(),
  AT_SENDER_ID: Joi.string().default('PASSMASTER'),

  AWS_S3_BUCKET: Joi.string().allow('').default(''),
  AWS_ACCESS_KEY_ID: Joi.string().allow('').default(''),
  AWS_SECRET_ACCESS_KEY: Joi.string().allow('').default(''),
  AWS_REGION: Joi.string().default('af-south-1'),
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
  SEED_ADMIN_PASSWORD: Joi.string().min(8).default('change_me_strong_8+'),
  SEED_ADMIN_NAME: Joi.string().default('Platform Admin'),

  THROTTLE_SHORT_LIMIT: Joi.number().integer().positive().default(30),
  THROTTLE_SHORT_TTL: Joi.number().integer().positive().default(10),
  THROTTLE_LONG_LIMIT: Joi.number().integer().positive().default(200),
  THROTTLE_LONG_TTL: Joi.number().integer().positive().default(60),
});
