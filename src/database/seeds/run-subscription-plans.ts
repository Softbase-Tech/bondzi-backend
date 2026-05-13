import 'dotenv/config';
import 'reflect-metadata';
import dataSource from '../../../ormconfig';
import { seedSubscriptionPlans } from './subscription-plans.seed';

async function main(): Promise<void> {
  await dataSource.initialize();
  await seedSubscriptionPlans(dataSource);
  await dataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
