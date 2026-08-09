import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsBearerGuard } from './metrics.guard';

/**
 * Locks in the security shape of the /metrics endpoint:
 *   - fails CLOSED when the token is unset or too short
 *   - constant-time compares the presented bearer
 *   - rejects wrong tokens, accepts the exact token
 *
 * If anyone refactors this and the "empty token === fail closed"
 * guarantee regresses, every Prometheus scrape would surface the
 * heap/queue/AI-cost signal publicly. The test stops that.
 */

function makeCtx(authHeader: string | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: authHeader ? { authorization: authHeader } : {},
      }),
    }),
  } as unknown as ExecutionContext;
}

function makeGuard(token: string): MetricsBearerGuard {
  const cfg = {
    get: (key: string) =>
      key === 'observability.metrics.bearerToken' ? token : undefined,
  } as unknown as ConfigService;
  return new MetricsBearerGuard(cfg);
}

describe('MetricsBearerGuard', () => {
  const validToken = 'a'.repeat(32);

  it('fails closed when the configured token is empty', () => {
    const guard = makeGuard('');
    expect(guard.canActivate(makeCtx('Bearer ' + validToken))).toBe(false);
  });

  it('fails closed when the configured token is too short (<16 chars)', () => {
    const guard = makeGuard('short');
    expect(guard.canActivate(makeCtx('Bearer short'))).toBe(false);
  });

  it('rejects requests with no Authorization header', () => {
    const guard = makeGuard(validToken);
    expect(guard.canActivate(makeCtx(undefined))).toBe(false);
  });

  it('rejects requests with the wrong scheme', () => {
    const guard = makeGuard(validToken);
    expect(guard.canActivate(makeCtx('Basic ' + validToken))).toBe(false);
  });

  it('rejects wrong tokens of equal length', () => {
    const guard = makeGuard(validToken);
    expect(guard.canActivate(makeCtx('Bearer ' + 'b'.repeat(32)))).toBe(false);
  });

  it('rejects tokens of different lengths (no length-leak via timing throw)', () => {
    const guard = makeGuard(validToken);
    expect(guard.canActivate(makeCtx('Bearer short'))).toBe(false);
    expect(guard.canActivate(makeCtx('Bearer ' + 'a'.repeat(64)))).toBe(false);
  });

  it('accepts the exact configured token', () => {
    const guard = makeGuard(validToken);
    expect(guard.canActivate(makeCtx('Bearer ' + validToken))).toBe(true);
  });
});
