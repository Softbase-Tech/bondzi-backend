import 'reflect-metadata';
// Sentry must be imported before the application so instrumentation hooks
// register in time. No-ops when SENTRY_DSN is unset (dev / CI).
import * as Sentry from '@sentry/node';
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 0,
    // Don't send PII by default; flip in Sentry project settings if needed.
    sendDefaultPii: false,
  });
}

import { NestFactory, Reflector } from '@nestjs/core';
import {
  ClassSerializerInterceptor,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import {
  json,
  raw,
  urlencoded,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { AppModule } from './app.module';
import { WorkerModule } from './worker.module';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

async function bootstrap() {
  // WORKER_MODE=true boots a headless app context that processes BullMQ
  // queues and runs @Cron-decorated jobs (the cron handlers each guard
  // themselves with the same env check). No HTTP listener, no Swagger,
  // no global middleware — just the DI graph.
  //
  // The api and worker containers share the same image; the only thing
  // that changes between them is this env var.
  if (process.env.WORKER_MODE === 'true') {
    const workerLogger = new Logger('Worker');
    const ctx = await NestFactory.createApplicationContext(WorkerModule, {
      bufferLogs: true,
    });
    ctx.enableShutdownHooks();
    // tini (in the Dockerfile) forwards SIGTERM here; ctx.close() drains
    // in-flight BullMQ jobs before the process exits.
    const shutdown = async (signal: string) => {
      workerLogger.log(`[worker] received ${signal}, draining...`);
      await ctx.close();
      process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
    workerLogger.log(
      `🛠️  Worker process running (env=${process.env.NODE_ENV})`,
    );
    return;
  }

  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  const logger = new Logger('Bootstrap');
  const config = app.get(ConfigService);

  const port = config.get<number>('app.port')!;
  const apiPrefix = config.get<string>('app.apiPrefix')!;
  const corsOrigins = config.get<string[]>('app.corsOrigins') ?? [];
  const env = config.get<string>('app.env');

  app.setGlobalPrefix(apiPrefix, { exclude: ['health'] });

  // Payment providers send unparsed JSON; we need the raw body on the webhook
  // routes for signature verification. Every other route gets the normal
  // JSON parser. Path is a prefix so all /payments/webhooks/:provider variants
  // (paystack, stripe, flutterwave, ...) are covered.
  app.use(
    '/api/v1/payments/webhooks',
    raw({ type: '*/*' }),
    (
      req: Request & { rawBody?: Buffer },
      _res: Response,
      next: NextFunction,
    ) => {
      const buf = req.body as Buffer | undefined;
      req.rawBody = buf;
      try {
        req.body =
          buf && buf.length > 0
            ? (JSON.parse(buf.toString('utf8')) as unknown)
            : {};
      } catch {
        req.body = {};
      }
      next();
    },
  );
  app.use(json({ limit: '2mb' }));
  app.use(urlencoded({ extended: true, limit: '2mb' }));

  app.use(cookieParser());
  app.use(
    helmet({
      crossOriginResourcePolicy: false,
      contentSecurityPolicy: env === 'production' ? undefined : false,
    }),
  );

  app.enableCors({
    origin: corsOrigins.length ? corsOrigins : true,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalInterceptors(
    new ClassSerializerInterceptor(app.get(Reflector)),
    new TransformInterceptor(),
  );

  // Swagger — hidden /admin endpoints stay out of the public spec via @ApiExcludeEndpoint.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('PassMaster Ghana API')
    .setDescription('WASSCE/BECE AI exam-prep backend — REST API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  app.enableShutdownHooks();

  await app.listen(port, '0.0.0.0');
  logger.log(
    `🚀 PassMaster backend running on :${port}/${apiPrefix} (env=${env})`,
  );
  logger.log(`📘 Swagger docs at http://localhost:${port}/docs`);
}

void bootstrap();
