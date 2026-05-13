/**
 * TypeORM CLI DataSource.
 * Used by `npm run migration:*`. Runtime datasource lives in src/config/database.config.ts.
 */
import 'dotenv/config';
import { DataSource } from 'typeorm';

const url =
  process.env.DATABASE_URL ??
  'postgresql://passmaster:passmaster@localhost:5432/passmaster';
const sslEnabled = process.env.DATABASE_SSL === 'true';

export default new DataSource({
  type: 'postgres',
  url,
  ssl: sslEnabled ? { rejectUnauthorized: false } : false,
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/database/migrations/*.ts'],
  migrationsTableName: 'typeorm_migrations',
  synchronize: false,
  logging: process.env.DATABASE_LOGGING === 'true',
});
