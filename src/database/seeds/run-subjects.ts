import 'dotenv/config';
import 'reflect-metadata';
import dataSource from '../../../ormconfig';
import { seedSubjects } from './subjects.seed';

async function main() {
  await dataSource.initialize();
  await seedSubjects(dataSource);

  console.log('[seed] subjects seeded');
  await dataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
