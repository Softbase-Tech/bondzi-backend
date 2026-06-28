import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Gauge } from 'prom-client';
import {
  InjectMetric,
  makeCounterProvider,
  makeHistogramProvider,
  makeGaugeProvider,
} from '@willsoto/nestjs-prometheus';

/**
 * Domain-specific metrics exposed alongside the default Node ones.
 *
 * Cardinality rules:
 *   - Labels MUST be low-cardinality. Routes (`/users/:id` style) are
 *     fine; user IDs / phone numbers / question IDs are NOT — they
 *     would explode the time-series count and blow past Grafana
 *     Cloud's 10k-series free-tier cap within a day.
 *   - When in doubt, log it (Loki tolerates high cardinality body
 *     fields) and only promote to a metric label if you genuinely
 *     need to aggregate across it on a dashboard.
 *
 * To add a new metric:
 *   1. Add the provider below (`make*Provider({ name, help, labelNames })`)
 *   2. Add a getter on this service
 *   3. Inject the service and call `.inc()` / `.observe()` / `.set()`
 */

export const HTTP_REQUEST_DURATION = 'bondzi_http_request_duration_seconds';
export const HTTP_REQUESTS_TOTAL = 'bondzi_http_requests_total';
export const LOGIN_ATTEMPTS_TOTAL = 'bondzi_auth_login_attempts_total';
export const OTP_SENDS_TOTAL = 'bondzi_auth_otp_sends_total';
export const AI_GENERATION_TOTAL = 'bondzi_ai_generation_total';
export const AI_COST_USD_TOTAL = 'bondzi_ai_cost_usd_total';
export const PUSH_SENDS_TOTAL = 'bondzi_push_sends_total';
export const PAYMENT_EVENTS_TOTAL = 'bondzi_payment_events_total';
export const QUEUE_DEPTH = 'bondzi_queue_depth';
export const EMAIL_SENDS_TOTAL = 'bondzi_email_sends_total';

export const metricProviders = [
  makeHistogramProvider({
    name: HTTP_REQUEST_DURATION,
    help: 'HTTP request duration in seconds, bucketed by route + status',
    labelNames: ['method', 'route', 'status'],
    // Buckets tuned for an api whose hot paths return in <100ms and
    // whose tail (AI / large queries) lands under 5s. 5s+ is "the AI
    // job is hanging" territory and worth visualizing separately.
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  }),
  makeCounterProvider({
    name: HTTP_REQUESTS_TOTAL,
    help: 'Total HTTP requests by method, route, status',
    labelNames: ['method', 'route', 'status'],
  }),
  makeCounterProvider({
    name: LOGIN_ATTEMPTS_TOTAL,
    help: 'Login attempts by outcome',
    labelNames: ['outcome'], // 'success' | 'invalid_creds' | 'locked' | 'unverified'
  }),
  makeCounterProvider({
    name: OTP_SENDS_TOTAL,
    help: 'OTP sends by outcome',
    labelNames: ['outcome'], // 'sent' | 'rate_limited' | 'provider_error'
  }),
  makeCounterProvider({
    name: AI_GENERATION_TOTAL,
    help: 'AI generation jobs by kind + outcome',
    labelNames: ['kind', 'outcome'], // kind: 'explanation' | 'pm_test', outcome: 'ok' | 'budget_exceeded' | 'error'
  }),
  makeCounterProvider({
    name: AI_COST_USD_TOTAL,
    help: 'Cumulative AI cost in USD',
    labelNames: ['kind'], // 'explanation' | 'pm_test'
  }),
  makeCounterProvider({
    name: PUSH_SENDS_TOTAL,
    help: 'Push notification dispatch outcomes',
    labelNames: ['outcome'], // 'sent' | 'invalid_token' | 'error'
  }),
  makeCounterProvider({
    name: PAYMENT_EVENTS_TOTAL,
    help: 'Payment webhook events processed',
    labelNames: ['provider', 'event', 'outcome'], // outcome: 'ok' | 'mismatch' | 'duplicate' | 'error'
  }),
  makeGaugeProvider({
    name: QUEUE_DEPTH,
    help: 'BullMQ queue depth by queue + state',
    labelNames: ['queue', 'state'], // state: 'waiting' | 'active' | 'failed' | 'delayed'
  }),
  makeCounterProvider({
    name: EMAIL_SENDS_TOTAL,
    help: 'Transactional email dispatch outcomes',
    labelNames: ['event', 'outcome'], // outcome: 'sent' | 'failed' | 'skipped' | 'dry_run'
  }),
];

@Injectable()
export class MetricsService {
  constructor(
    @InjectMetric(HTTP_REQUEST_DURATION)
    public readonly httpDuration: Histogram<string>,
    @InjectMetric(HTTP_REQUESTS_TOTAL)
    public readonly httpRequests: Counter<string>,
    @InjectMetric(LOGIN_ATTEMPTS_TOTAL)
    public readonly loginAttempts: Counter<string>,
    @InjectMetric(OTP_SENDS_TOTAL) public readonly otpSends: Counter<string>,
    @InjectMetric(AI_GENERATION_TOTAL)
    public readonly aiGenerations: Counter<string>,
    @InjectMetric(AI_COST_USD_TOTAL) public readonly aiCost: Counter<string>,
    @InjectMetric(PUSH_SENDS_TOTAL) public readonly pushSends: Counter<string>,
    @InjectMetric(PAYMENT_EVENTS_TOTAL)
    public readonly paymentEvents: Counter<string>,
    @InjectMetric(QUEUE_DEPTH) public readonly queueDepth: Gauge<string>,
    @InjectMetric(EMAIL_SENDS_TOTAL)
    public readonly emailSends: Counter<string>,
  ) {}

  /**
   * Normalize an Express route into a low-cardinality label.
   * `/users/:id/exams/abc-123` collapses to `/users/:id/exams/:id`
   * via the framework — but ad-hoc IDs that slipped past Nest's
   * router (e.g. payment callback URLs) still need scrubbing here.
   * Anything that looks like a UUID or a long numeric ID is folded.
   */
  static routeLabel(url: string): string {
    const path = url.split('?')[0];
    return path
      .replace(
        /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        '/:uuid',
      )
      .replace(/\/\d{4,}/g, '/:id')
      .slice(0, 120);
  }
}
