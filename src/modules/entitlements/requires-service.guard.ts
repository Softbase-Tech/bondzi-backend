import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EntitlementService } from '../../common/types/enums';
import { EntitlementsService } from './entitlements.service';
import { REQUIRES_SERVICE_METADATA } from './requires-service.decorator';

/**
 * Companion guard for `@RequiresService(...)`. Skips silently if the
 * decorator isn't present (so undecorated endpoints stay untouched).
 * Delegates the whole gate to `EntitlementsService.assertAndConsume`,
 * which throws the right HTTP shape:
 *
 *   • policy row missing → 503 (app bug, fail closed)
 *   • disabled for tier → 403
 *   • config gate (requiresFormLevel) → 403
 *   • daily cap reached → 429
 *
 * Attaches `req.entitlement` = { policy, usedCount } on success so
 * downstream handlers can surface "3 of 20 used today" to the client
 * without a second DB read.
 */
@Injectable()
export class RequiresServiceGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const service = this.reflector.getAllAndOverride<EntitlementService>(
      REQUIRES_SERVICE_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (!service) return true;

    const req = context.switchToHttp().getRequest<{
      user?: { id?: string };
      entitlement?: unknown;
    }>();
    const userId = req.user?.id;
    if (!userId) {
      // Decorated but no authed user — this means the developer forgot
      // to also apply the JwtAuthGuard. Fail explicit rather than
      // silently letting an anonymous caller through.
      throw new UnauthorizedException(
        'Authentication is required for this feature.',
      );
    }

    const result = await this.entitlements.assertAndConsume(userId, service);
    req.entitlement = result;
    return true;
  }
}
