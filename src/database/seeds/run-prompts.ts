import 'dotenv/config';
import 'reflect-metadata';
import dataSource from '../../../ormconfig';
import { seedPrompts } from './prompts.seed';

async function main() {
  await dataSource.initialize();
  await seedPrompts(dataSource);

  console.log('[seed] prompt templates seeded');
  await dataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
