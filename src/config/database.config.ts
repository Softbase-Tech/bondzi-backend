import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

export default registerAs('database', (): TypeOrmModuleOptions => {
  const url = process.env.DATABASE_URL as string;
  const sslEnabled = process.env.DATABASE_SSL === 'true';

  return {
    type: 'postgres',
    url,
    ssl: sslEnabled ? { rejectUnauthorized: false } : false,
    // Entities are auto-discovered from dist at runtime and src during local dev.
    autoLoadEntities: true,
    // Never synchronize in production — migrations are the only source of schema changes.
    synchronize: false,
    logging: process.env.DATABASE_LOGGING === 'true',
    migrations: [__dirname + '/../database/migrations/*.{js,ts}'],
    migrationsTableName: 'typeorm_migrations',
    extra: {
      min: parseInt(process.env.DATABASE_POOL_MIN ?? '5', 10),
      max: parseInt(process.env.DATABASE_POOL_MAX ?? '20', 10),
      /**
       * Pin the session timezone to UTC.
       *
       * `created_at::date` on a `timestamptz` is an *implicit*
       * `AT TIME ZONE current_setting('TimeZone')`. Without this the
       * session TZ is whatever the server or container defaults to —
       * today that happens to be UTC, so every daily aggregate is right
       * by luck rather than by construction. A future image carrying a
       * `TZ` env, or a managed Postgres with a non-UTC default, would
       * shift every day boundary silently and corrupt reporting history
       * that is already persisted as immutable daily snapshots.
       *
       * Ghana is UTC+0 year-round with no DST, so pinning UTC also keeps
       * these casts numerically identical to the Accra wall-clock dates
       * used by `user_service_usage.day` and `users.last_study_date`.
       */
      options: '-c timezone=UTC',
    },
  };
});
