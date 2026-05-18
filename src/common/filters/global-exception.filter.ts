import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

interface ErrorPayload {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
  requestId?: string;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let statusCode: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let error = 'InternalServerError';

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const r = res as { message?: string | string[]; error?: string };
        message = r.message ?? message;
        error = r.error ?? exception.name;
      }
    } else if (exception instanceof Error) {
      // CRITICAL: NEVER pass a raw Error.message through to the client
      // on a non-HttpException. TypeORM's QueryFailedError surfaces
      // table + column names + SQL fragments; bcrypt errors leak the
      // hash format; AWS SDK errors carry IAM hints. The stack trace
      // is still logged below for ops; the client only sees a generic
      // "Internal server error" plus a request id for correlation.
      message = 'Internal server error';
      error = 'InternalServerError';
    }

    const payload: ErrorPayload = {
      statusCode,
      error,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
      requestId: (request.headers['x-request-id'] as string) ?? undefined,
    };

    if (statusCode >= 500) {
      this.logger.error(
        {
          path: request.url,
          method: request.method,
          statusCode,
          error,
          message,
        },
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn({
        path: request.url,
        method: request.method,
        statusCode,
        message,
      });
    }

    response.status(statusCode).json(payload);
  }
}
