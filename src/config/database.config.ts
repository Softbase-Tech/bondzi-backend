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
    },
  };
});
