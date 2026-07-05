import { SetMetadata } from '@nestjs/common';
import { EntitlementService } from '../../common/types/enums';

export const REQUIRES_SERVICE_METADATA = 'requires_service';

/**
 * Marks a controller method as gated by the entitlements matrix.
 * The `RequiresServiceGuard` (globally wired in EntitlementsModule)
 * reads this metadata, resolves the caller's tier for their current
 * level, applies the (tier, service) policy from `tier_services`, and
 * atomically increments the daily counter — throwing 403 if disabled,
 * 429 if the cap is reached.
 *
 * Usage:
 *
 *   @RequiresService(EntitlementService.LEVEL_TESTS)
 *   @Post('level-tests/start')
 *   startLevelTest(...) { ... }
 *
 * The guard runs AFTER `JwtAuthGuard` so the resolved user is available
 * on the request. Endpoints without this decorator are not gated.
 */
export const RequiresService = (service: EntitlementService) =>
  SetMetadata(REQUIRES_SERVICE_METADATA, service);
