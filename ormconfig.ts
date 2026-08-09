/**
 * TypeORM CLI DataSource.
 * Used by `npm run migration:*` and by the standalone seed scripts at
 * `src/database/seeds/run-*.ts`. Runtime app datasource lives at
 * `src/config/database.config.ts` (NestJS module).
 *
 * Path strategy — this file is loaded in THREE distinct contexts, and
 * each puts `__dirname` somewhere different:
 *   1. dev / `npm run migration:*` (ts-node from repo root):
 *        __dirname = <repo>, source .ts files live at <repo>/src/.
 *   2. prod `npm run migration:run` inside the image (ts-node-cli):
 *        __dirname = /app, but /app/src/ does NOT exist — the
 *        Dockerfile only ships compiled .js at /app/dist/src/.
 *   3. prod seed via `node dist/src/.../run-*.js`:
 *        __dirname = /app/dist, source .js files live at /app/dist/src/.
 *
 * One probe — "does `src/` exist right next to me?" — disambiguates
 * all three. Picking the wrong path silently matches zero files and
 * TypeORM says "No migrations are pending" / "No entity metadata"
 * with no other signal. Hence the explicit check.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource } from 'typeorm';

const url =
  process.env.DATABASE_URL ??
  'postgresql://passmaster:passmaster@localhost:5432/passmaster';
const sslEnabled = process.env.DATABASE_SSL === 'true';

const sourceRoot = fs.existsSync(path.join(__dirname, 'src'))
  ? path.join(__dirname, 'src')
  : path.join(__dirname, 'dist', 'src');

export default new DataSource({
  type: 'postgres',
  url,
  ssl: sslEnabled ? { rejectUnauthorized: false } : false,
  entities: [`${sourceRoot}/**/*.entity.{js,ts}`],
  migrations: [`${sourceRoot}/database/migrations/*.{js,ts}`],
  migrationsTableName: 'typeorm_migrations',
  synchronize: false,
  logging: process.env.DATABASE_LOGGING === 'true',
});
