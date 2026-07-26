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
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { WorkerModule } from './worker.module';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { TrustedProxyManager } from './common/utils/trusted-proxies.util';

async function bootstrap() {
  // WORKER_MODE=true boots a headless app context that processes BullMQ
  // queues and runs @Cron-decorated jobs (the cron handlers each guard
  // themselves with the same env check). No HTTP listener, no Swagger,
  // no global middleware — just the DI graph.
  //
  // The api and worker containers share the same image; the only thing
  // that changes between them is this env var.
  if (process.env.WORKER_MODE === 'true') {
    const ctx = await NestFactory.createApplicationContext(WorkerModule, {
      bufferLogs: true,
    });
    // Worker inherits the same pino logger so its lines flow into the
    // same Loki stream with `app=bondzi-api` (the label is set in
    // logger.module.ts — we could split by container later).
    ctx.useLogger(ctx.get(PinoLogger));
    const workerLogger = new Logger('Worker');
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
    // bufferLogs is safe to leave ON in every env now that pino owns
    // the log pipeline — useLogger() below flushes the buffer THROUGH
    // pino, so even module-init logs come out as JSON in prod and
    // pretty-printed in dev. The "silent app on bad config" footgun
    // is gone because pino's stdout target is sync and always wired.
    bufferLogs: true,
    rawBody: true,
  });
  // Swap Nest's default ConsoleLogger for pino BEFORE any other code
  // runs. Buffered init lines are flushed through pino in order.
  app.useLogger(app.get(PinoLogger));
  const logger = new Logger('Bootstrap');
  const config = app.get(ConfigService);

  const port = config.get<number>('app.port')!;
  const apiPrefix = config.get<string>('app.apiPrefix')!;
  const corsOrigins = config.get<string[]>('app.corsOrigins') ?? [];
  const env = config.get<string>('app.env');

  // CRITICAL: the chain in production is `client → Cloudflare → nginx →
  // api`, so two upstream hops appear in `X-Forwarded-For` before
  // Express sees the request. Without `trust proxy` Express would
  // pin `req.ip` to nginx's socket peer — login lockout, OTP rate
  // limits, and ThrottlerGuard would collapse to ONE global bucket,
  // and one bot could lock out every user.
  //
  // We trust both layers, but ONLY those layers, so an attacker who
  // reaches the origin directly with a forged X-Forwarded-For still
  // gets identified by their real socket IP. `TrustedProxyManager`
  // hardcodes Cloudflare's current ranges as a baseline (boot survives
  // without internet) and refreshes them from Cloudflare's published
  // lists every 24h — when they add a /18 next year we pick it up
  // automatically with no code change. Loopback + Docker bridge
  // ranges are trusted too so the nginx → api hop inside compose
  // works. See src/common/utils/trusted-proxies.util.ts for the
  // baseline and refresh shape.
  const trustedProxies = new TrustedProxyManager();
  trustedProxies.startBackgroundRefresh();
  const expressApp = app.getHttpAdapter().getInstance() as {
    set: (key: string, value: unknown) => void;
  };
  expressApp.set('trust proxy', (addr: string) =>
    trustedProxies.isTrusted(addr),
  );

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
  app.use(
    '/api/v1/mail/webhooks',
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
  // Body-size cap. Two layers (nginx `client_max_body_size 4m;` and the
  // Express parser below) must match or the layer with the tighter cap
  // silently truncates and the other layer returns a confusing error.
  // 4mb covers: AI explanation payloads with embedded LaTeX (~50KB),
  // OCR'd question screenshots from the admin (~1–2MB), and a generous
  // margin. Anything larger is abuse and gets a clean 413.
  app.use(json({ limit: '4mb' }));
  app.use(urlencoded({ extended: true, limit: '4mb' }));

  app.use(cookieParser());
  app.use(
    helmet({
      crossOriginResourcePolicy: false,
      contentSecurityPolicy: env === 'production' ? undefined : false,
    }),
  );

  // CRITICAL: in production with `credentials: true`, falling back to
  // `origin: true` reflects ANY origin — every site on the internet can
  // call our API with the user's cookies. Hard-fail at boot instead of
  // silently leaving the door open.
  if (env === 'production' && corsOrigins.length === 0) {
    throw new Error(
      'CORS_ORIGINS must be set to a non-empty comma-separated list in production',
    );
  }
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
    .setTitle('Bondzi Ghana API')
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
  logger.log(`🚀 Bondzi backend running on :${port}/${apiPrefix} (env=${env})`);
  logger.log(`📘 Swagger docs at http://localhost:${port}/docs`);

  // Provenance line for AI generation. Answers "is this instance
  // talking to Bedrock or Ollama?" without hunting through env
  // dumps. Prints once at boot per process — matches the pattern
  // AiGenerationFactory uses when it resolves the client.
  const aiProvider = (process.env.AI_PROVIDER ?? 'bedrock')
    .trim()
    .toLowerCase();
  const aiCap = process.env.AI_MAX_ITEMS_PER_BATCH ?? '1000';
  if (aiProvider === 'self_hosted') {
    const base = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
    const model = process.env.OLLAMA_MODEL ?? 'llama3.1:8b';
    logger.log(
      `🤖 AI provider: ollama:${model} (base=${base}) · max items/batch: ${aiCap}`,
    );
  } else {
    logger.log(`🤖 AI provider: bedrock · max items/batch: ${aiCap}`);
  }
}

void bootstrap();
