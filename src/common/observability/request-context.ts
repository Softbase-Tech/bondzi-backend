import { ClsModule } from 'nestjs-cls';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Continuation-local storage for per-request metadata. Used by the pino
 * logger mixin so every log line emitted while a request is in flight
 * carries the same requestId WITHOUT having to thread it through every
 * function signature.
 *
 * Shape stored in CLS:
 *   - requestId: string  — UUID or the value of the incoming
 *                          `X-Request-ID` header.
 *   - userId?: string    — populated downstream by the JWT guard when
 *                          the request is authenticated.
 */

const REQUEST_ID_HEADER = 'x-request-id';
// node-cls's setup runs INSIDE express middleware so the synchronous
// crypto API is fine — it's nanoseconds and never blocks.
function pickRequestId(req: Request): string {
  const fromHeader = req.headers[REQUEST_ID_HEADER];
  if (typeof fromHeader === 'string' && fromHeader.length > 0) {
    // Header trusted shape: max 128 chars, ascii-printable only. Caller
    // (mobile / admin / curl) can choose whatever they want. If anyone
    // tries to wedge in a newline to confuse log parsers, slice it off.
    return fromHeader.slice(0, 128).replace(/[^\x20-\x7e]/g, '');
  }
  return randomUUID();
}

export const RequestContextModule = ClsModule.forRoot({
  global: true,
  middleware: {
    mount: true,
    // Generates the requestId and stamps the response header. Runs
    // before any controller / interceptor / guard, so every log line
    // in the request's lifetime sees the same ID.
    setup: (cls, req: Request, res: Response) => {
      const requestId = pickRequestId(req);
      cls.set('requestId', requestId);
      res.setHeader(REQUEST_ID_HEADER, requestId);
    },
  },
});

export const REQUEST_ID_CLS_KEY = 'requestId';
export const USER_ID_CLS_KEY = 'userId';
