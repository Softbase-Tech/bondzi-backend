import { registerAs } from '@nestjs/config';

/**
 * Centralized observability config. Read by the pino logger factory and
 * the metrics module at boot. All values default to "do nothing" so a
 * developer running locally without any Grafana setup gets clean stdout
 * logs and a still-functional /metrics endpoint guarded only by the
 * bearer token (empty token === effectively disabled).
 */
export default registerAs('observability', () => ({
  logLevel: process.env.LOG_LEVEL ?? 'info',
  loki: {
    // When url is empty we skip the transport entirely — logs go to
    // stdout only. That's the dev / CI shape and the fallback if Loki
    // creds are misconfigured in prod.
    url: process.env.LOKI_URL ?? '',
    user: process.env.LOKI_USER ?? '',
    apiKey: process.env.LOKI_API_KEY ?? '',
  },
  metrics: {
    enabled:
      (process.env.METRICS_ENABLED ?? 'true').toLowerCase() === 'true' &&
      process.env.NODE_ENV !== 'test',
    bearerToken: process.env.METRICS_BEARER_TOKEN ?? '',
  },
}));
