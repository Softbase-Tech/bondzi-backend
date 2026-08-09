import { Module } from '@nestjs/common';
import { AppModule } from './app.module';

/**
 * Module entry point for the **worker** process — used by `main.ts` when
 * `WORKER_MODE=true`. Boots the same dependency graph as `AppModule` via
 * `NestFactory.createApplicationContext()` (no HTTP listener).
 *
 * Why wrap AppModule instead of slimming it:
 *   - The lean approach (only import processor-bearing modules) is theoretically
 *     leaner but in practice each Processor / @Cron pulls a long, easily-broken
 *     dependency chain (SubscriptionRenewal needs Subscription repo + Notifications,
 *     LeaderboardWinner needs Users + LeaderboardSnapshot, etc.). Missing one
 *     dependency manifests at runtime, in the worker, in production.
 *   - The cost of the extra controller classes loaded at boot is ~30–50 MB of
 *     RAM, well below our 512 MB worker container ceiling.
 *   - Cron-handler safety: every @Cron method in `src/jobs/*.job.ts` checks
 *     `process.env.WORKER_MODE === 'true'` and returns early when not — so
 *     ScheduleModule loaded in AppModule does not cause api+worker to
 *     double-fire scheduled tasks. BullMQ Processor classes are deduplicated
 *     by Redis distributed lock so duplicate processing is not a concern.
 *
 * Revisit and slim if memory pressure proves the savings worth the
 * maintenance cost.
 */
@Module({ imports: [AppModule] })
export class WorkerModule {}
