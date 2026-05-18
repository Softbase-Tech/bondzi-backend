import { LoggerModule } from 'nestjs-pino';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TransportTargetOptions } from 'pino';
import { REQUEST_ID_CLS_KEY, USER_ID_CLS_KEY } from './request-context';

/**
 * Pino-based logger that replaces NestJS's default ConsoleLogger.
 *
 * Three behaviors stitched together:
 *   1. `pino-http` auto-logs every HTTP request on completion. One line
 *      per request with status + duration + route. This REPLACES the
 *      old custom LoggingInterceptor.
 *   2. A `mixin` reads the current requestId (and userId, if the JWT
 *      guard has set it) from CLS and stamps every log line that fires
 *      during the request's lifetime. Background jobs that have no CLS
 *      get nothing — that's correct, they aren't tied to a request.
 *   3. Pretty-print to stdout in dev (`pino-pretty`), JSON + Loki push
 *      in production. Loki transport runs in a worker thread so it
 *      never touches the main event loop; if Loki is unreachable the
 *      transport drops the line after retry rather than blocking.
 *
 * Failure isolation:
 *   - LOKI_URL unset → no transport, logs to stdout only (dev / CI).
 *   - Loki push fails → pino-loki retries with backoff, drops oldest
 *     entries when its bounded queue fills. Main loop is never blocked.
 *   - Pino itself never throws; logger calls are nanoseconds.
 */
export const PinoLoggerModule = LoggerModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService, ClsService],
  useFactory: (cfg: ConfigService, cls: ClsService) => {
    const env = cfg.get<string>('app.env');
    const level = cfg.get<string>('observability.logLevel') ?? 'info';
    const lokiUrl = cfg.get<string>('observability.loki.url') ?? '';
    const lokiUser = cfg.get<string>('observability.loki.user') ?? '';
    const lokiKey = cfg.get<string>('observability.loki.apiKey') ?? '';

    const isProd = env === 'production' || env === 'staging';
    const lokiConfigured = !!lokiUrl && !!lokiUser && !!lokiKey;

    // Build the transport. In dev we want pretty-printed lines for
    // humans; in prod we want JSON to stdout AND (if configured) a
    // simultaneous push to Loki. The `targets` array lets a single
    // pino instance fan out to multiple sinks.
    const targets: TransportTargetOptions[] = [];
    if (!isProd) {
      targets.push({
        target: 'pino-pretty',
        level,
        options: {
          colorize: true,
          singleLine: false,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,context,req,res',
        },
      });
    } else {
      // Plain JSON to stdout — read by Docker → journald → never lost
      // even if Loki ingest is down.
      targets.push({
        target: 'pino/file',
        level,
        options: { destination: 1 }, // stdout
      });
      if (lokiConfigured) {
        targets.push({
          target: 'pino-loki',
          level,
          options: {
            host: lokiUrl,
            basicAuth: { username: lokiUser, password: lokiKey },
            // Group lines into one POST every 5s OR every 1000 lines,
            // whichever lands first. Caps outbound POST/sec from this
            // box at ~12/min — kind to Lightsail's bandwidth budget
            // and kind to Loki's ingest quota.
            batching: true,
            interval: 5,
            // Labels (low-cardinality) are how Grafana Cloud indexes
            // logs — anything user-specific MUST stay in the JSON
            // body, not here. Cardinality explosion is the #1 way to
            // get throttled by Loki.
            labels: {
              app: 'bondzi-api',
              env: env ?? 'unknown',
            },
            // 5s timeout per POST. If Loki is wedged we bail and let
            // the next batch try. Never block.
            timeout: 5000,
            silenceErrors: false,
          },
        });
      }
    }

    return {
      pinoHttp: {
        level,
        transport: { targets },

        // Stamp requestId + userId (when present) onto every log line
        // emitted while a request is in flight. CLS lookup is O(1).
        mixin: () => {
          const requestId = cls.get<string>(REQUEST_ID_CLS_KEY);
          const userId = cls.get<string>(USER_ID_CLS_KEY);
          const out: Record<string, string> = {};
          if (requestId) out.requestId = requestId;
          if (userId) out.userId = userId;
          return out;
        },

        // pino-http's auto request-log shape. We strip noisy fields
        // and only keep what's actually useful for debugging.
        customProps: (req: IncomingMessage) => {
          const r = req as IncomingMessage & {
            url?: string;
            method?: string;
          };
          return {
            method: r.method,
            // Trim query string from the route label — would otherwise
            // explode cardinality if Loki labelled by URL.
            path: (r.url ?? '').split('?')[0],
          };
        },

        // Per-request log: ONE line on completion, NOT one on receive.
        // Cuts log volume in half vs. naive "log start + end" patterns.
        autoLogging: {
          ignore: (req: IncomingMessage) => {
            // /health is hit every 5s by Docker — don't ship a line
            // each time. The container's own healthcheck is the
            // source of truth for liveness.
            const url = (req as { url?: string }).url ?? '';
            return url === '/health' || url.startsWith('/api/v1/health');
          },
        },
        // Custom log level per status — 5xx is error, 4xx is warn,
        // everything else is info. Matches the prior interceptor's
        // shape so dashboards built on those don't break.
        customLogLevel: (
          _req: IncomingMessage,
          res: ServerResponse,
          err: Error | undefined,
        ) => {
          if (err || res.statusCode >= 500) return 'error';
          if (res.statusCode >= 400) return 'warn';
          return 'info';
        },

        // Don't dump the whole req/res object into every line — keep
        // bytes low for Loki ingest. The mixin already adds requestId.
        serializers: {
          req: () => undefined,
          res: () => undefined,
        },

        // Redact common credential-bearing fields if anything ever
        // leaks in via `logger.log({ payload })`. Defence-in-depth;
        // we already strip these at the controller/DTO layer.
        redact: {
          paths: [
            '*.password',
            '*.token',
            '*.refreshToken',
            '*.accessToken',
            '*.authorization',
            'req.headers.authorization',
            'req.headers.cookie',
            '*.fcmToken',
          ],
          censor: '[REDACTED]',
        },
      },
    };
  },
});
