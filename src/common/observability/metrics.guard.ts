import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';

/**
 * Locks `/api/v1/internal/metrics` behind a static bearer token.
 *
 * Two layers in prod:
 *   1. nginx returns 404 for this path from the public internet
 *      (bondzi.conf) — external scanners never see it exists.
 *   2. This guard (in-process)                — constant-time token check
 *      for any internal scraper (Grafana Alloy on the docker bridge,
 *      a developer with `docker exec`, etc).
 *
 * The token is constant-time-compared so a timing oracle can't be
 * used to brute it. If the env token is empty (e.g.
 * METRICS_BEARER_TOKEN unset in a misconfigured prod), the guard
 * fails CLOSED — better to lose a metrics scrape than to expose
 * heap / queue / cost signal even to anyone who lands on the bridge.
 */
@Injectable()
export class MetricsBearerGuard implements CanActivate {
  private readonly logger = new Logger('MetricsBearerGuard');

  constructor(private readonly cfg: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const expected = this.cfg.get<string>('observability.metrics.bearerToken');
    if (!expected || expected.length < 16) {
      // Fail closed — caller's misconfig is not our problem to paper over.
      this.logger.warn(
        'METRICS_BEARER_TOKEN unset or too short; rejecting /metrics scrape',
      );
      return false;
    }

    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!presented) return false;

    // Length-prefix check first so timingSafeEqual doesn't throw on a
    // length mismatch (it requires equal-length buffers). Different
    // lengths can't be a match anyway.
    const a = Buffer.from(expected);
    const b = Buffer.from(presented);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
