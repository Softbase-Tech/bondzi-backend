import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable, tap } from 'rxjs';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    const method: string = req.method;
    const url: string = req.url;
    const userId: string = req.user?.id ?? '-';
    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const durationMs = Date.now() - start;
          this.logger.log({ method, url, userId, durationMs, status: 'ok' });
        },
        error: (err: unknown) => {
          const durationMs = Date.now() - start;
          const message = err instanceof Error ? err.message : 'unknown';
          this.logger.warn({
            method,
            url,
            userId,
            durationMs,
            error: message,
          });
        },
      }),
    );
  }
}
