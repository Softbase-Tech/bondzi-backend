/**
 * Spec §1.2 alias. The actual cron lives in `subscription-renewal.job.ts`
 * (hourly scan that warns 3 days before expiry and auto-flips to expired).
 * Re-exported here so the jobs/ directory layout matches the spec literally.
 */
export { SubscriptionRenewalJob as SubscriptionExpiryJob } from './subscription-renewal.job';
