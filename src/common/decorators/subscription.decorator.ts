import { SetMetadata } from '@nestjs/common';

export const REQUIRES_SUBSCRIPTION_KEY = 'requiresSubscription';

/**
 * Marks a route as requiring an active paid subscription. Enforced by
 * SubscriptionGuard, which consults Redis cache first (subscription_status:{userId})
 * and falls back to DB.
 */
export const RequiresSubscription = () =>
  SetMetadata(REQUIRES_SUBSCRIPTION_KEY, true);
