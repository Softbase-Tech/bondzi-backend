import {
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequiresServiceGuard } from './requires-service.guard';
import type { EntitlementsService } from './entitlements.service';
import { EntitlementService } from '../../common/types/enums';

/**
 * Guard behaviours to lock in:
 *   - No @RequiresService decorator → skips silently (returns true).
 *   - Decorated + no authed user → UnauthorizedException (the
 *     developer forgot JwtAuthGuard OR route order is wrong).
 *   - Decorated + authed + policy disabled → 403 (bubbles from
 *     the service).
 *   - Decorated + authed + within cap → true, req.entitlement set.
 *   - Decorated + authed + at cap → 429 (bubbles from the service).
 */
describe('RequiresServiceGuard', () => {
  let guard: RequiresServiceGuard;
  let reflector: Reflector;
  let entitlements: { assertAndConsume: jest.Mock };
  let req: { user?: { id: string }; entitlement?: unknown };

  function makeContext(): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => () => undefined,
      getClass: () => class Cls {},
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    reflector = new Reflector();
    entitlements = { assertAndConsume: jest.fn() };
    guard = new RequiresServiceGuard(
      reflector,
      entitlements as unknown as EntitlementsService,
    );
    req = { user: { id: 'user-1' } };
  });

  it('returns true when the handler carries no @RequiresService decorator', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    expect(entitlements.assertAndConsume).not.toHaveBeenCalled();
  });

  it('throws Unauthorized when decorated but no req.user (missing JwtAuthGuard)', async () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue(EntitlementService.LEVEL_TESTS);
    req = {}; // no user
    await expect(guard.canActivate(makeContext())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('bubbles a Forbidden (disabled tier) from the service', async () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue(EntitlementService.MOCK_EXAMS);
    entitlements.assertAndConsume.mockRejectedValueOnce(
      new ForbiddenException('not on your tier'),
    );
    await expect(guard.canActivate(makeContext())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('bubbles a 429 (cap hit) from the service', async () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue(EntitlementService.LEVEL_TESTS);
    entitlements.assertAndConsume.mockRejectedValueOnce(
      new HttpException('cap hit', HttpStatus.TOO_MANY_REQUESTS),
    );
    await expect(guard.canActivate(makeContext())).rejects.toThrow('cap hit');
  });

  it('returns true on success and attaches req.entitlement for downstream handlers', async () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue(EntitlementService.AI_EXPLANATIONS);
    const result = {
      policy: { dailyCap: 20 } as never,
      usedCount: 3,
    };
    entitlements.assertAndConsume.mockResolvedValueOnce(result);
    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    expect(req.entitlement).toEqual(result);
    expect(entitlements.assertAndConsume).toHaveBeenCalledWith(
      'user-1',
      EntitlementService.AI_EXPLANATIONS,
    );
  });
});
