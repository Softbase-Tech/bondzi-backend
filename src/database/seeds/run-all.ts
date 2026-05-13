import 'dotenv/config';
import 'reflect-metadata';
import dataSource from '../../../ormconfig';
import { seedSubjects } from './subjects.seed';
import { seedPrompts } from './prompts.seed';
import { seedAdmin } from './admin.seed';
import { seedSubscriptionPlans } from './subscription-plans.seed';

/**
 * Combined v2 seeder. Runs the seeds in dependency order:
 *   subjects → prompts → admin → subscription plans
 * The admin seed has no FKs to subjects/prompts but the rest of the platform
 * needs subjects present before the admin logs in, so we keep this order.
 * Subscription plans run last — their own rows are self-contained but the
 * seed logs against Paystack if creds are available, and we want any earlier
 * hard failures to surface first.
 */
async function main(): Promise<void> {
  await dataSource.initialize();
  await seedSubjects(dataSource);
  console.log('[seed] subjects upserted');
  await seedPrompts(dataSource);
  console.log('[seed] prompt templates upserted');
  await seedAdmin(dataSource);
  console.log('[seed] superadmin upserted');
  await seedSubscriptionPlans(dataSource);
  await dataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
