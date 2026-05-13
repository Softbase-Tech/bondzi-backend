import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';

export interface EnvelopedResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
}

/**
 * Wraps all controller responses in { data: ... }. Services may return
 * pre-enveloped objects containing a `meta` key to forward metadata.
 */
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<
  T,
  EnvelopedResponse<T>
> {
  intercept(
    _ctx: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<EnvelopedResponse<T>> {
    return next.handle().pipe(
      map((value) => {
        if (value && typeof value === 'object' && 'data' in (value as object)) {
          return value as unknown as EnvelopedResponse<T>;
        }
        return { data: value } as EnvelopedResponse<T>;
      }),
    );
  }
}
