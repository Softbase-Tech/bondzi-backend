/**
 * TypeORM CLI DataSource.
 * Used by `npm run migration:*` and by the standalone seed scripts at
 * `src/database/seeds/run-*.ts`. Runtime app datasource lives at
 * `src/config/database.config.ts` (NestJS module).
 *
 * Path strategy:
 *   The entity/migration globs MUST work in both contexts:
 *     - dev:  this file lives at <repo>/ormconfig.ts and is loaded via
 *             ts-node. `__dirname` resolves to <repo>, and entity .ts
 *             sources live under <repo>/src.
 *     - prod: the Dockerfile copies ormconfig.ts to /app/, but the seed
 *             scripts execute the compiled /app/dist/ormconfig.js, whose
 *             `__dirname` is /app/dist. Compiled entity .js files live
 *             under /app/dist/src.
 *   Anchoring with `__dirname` + the `{js,ts}` extension makes one glob
 *   match in both contexts, without an env switch.
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
  entities: [`${__dirname}/src/**/*.entity.{js,ts}`],
  migrations: [`${__dirname}/src/database/migrations/*.{js,ts}`],
  migrationsTableName: 'typeorm_migrations',
  synchronize: false,
  logging: process.env.DATABASE_LOGGING === 'true',
});
