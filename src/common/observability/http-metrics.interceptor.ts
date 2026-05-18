import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { MetricsService } from './metrics.service';

/**
 * Records every HTTP request into the Prometheus histogram + counter.
 * Runs in parallel with pino-http's per-request log: logs answer
 * "what happened to request X?" and metrics answer "how slow is route
 * Y over the last hour?". Same data shape, different storage.
 *
 * The route label is derived from the matched Nest route pattern
 * (`/users/:id`), not the literal URL, so label cardinality stays low.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const method = req.method;
    // Express attaches `route` to the request once a route has matched;
    // its `path` is the parameterised pattern (`/users/:id`) — exactly
    // the low-cardinality label we want. Cast deliberately because
    // express's public types omit it.
    const matchedRoute = (req as { route?: { path?: string } }).route?.path;
    const route = MetricsService.routeLabel(
      matchedRoute ?? req.url ?? 'unknown',
    );
    const start = process.hrtime.bigint();

    const record = (statusCode: number) => {
      const elapsedNs = Number(process.hrtime.bigint() - start);
      const seconds = elapsedNs / 1e9;
      const status = String(statusCode);
      this.metrics.httpDuration
        .labels({ method, route, status })
        .observe(seconds);
      this.metrics.httpRequests.labels({ method, route, status }).inc();
    };

    return next.handle().pipe(
      tap({
        next: () => record(res.statusCode),
        // On error, GlobalExceptionFilter sets the final status — by
        // then the response is already flushed and `res.statusCode`
        // reflects what the client saw. Capture that.
        error: () => record(res.statusCode || 500),
      }),
    );
  }
}
