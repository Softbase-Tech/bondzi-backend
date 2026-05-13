import 'dotenv/config';
import 'reflect-metadata';
import dataSource from '../../../ormconfig';
import { seedAdmin } from './admin.seed';

async function main() {
  await dataSource.initialize();
  await seedAdmin(dataSource);

  console.log('[seed] superadmin upserted');
  await dataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
