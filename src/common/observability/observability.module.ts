import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import { MetricsController } from './metrics.controller';
import { MetricsBearerGuard } from './metrics.guard';
import { MetricsService, metricProviders } from './metrics.service';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';

/**
 * Wires:
 *   - prom-client's default Node metrics (heap, event loop lag, GC,
 *     active handles) into the prom registry.
 *   - The custom counter / histogram / gauge providers from
 *     metrics.service.ts.
 *   - MetricsController at /api/v1/internal/metrics (its base path is
 *     'internal/metrics' and the global prefix adds 'api/v1').
 *   - HttpMetricsInterceptor as a global interceptor — runs in
 *     parallel with pino-http's request logger.
 *
 * Marked global so any module can `@Inject(MetricsService)` without
 * having to import this module first.
 */
@Module({
  imports: [
    ConfigModule,
    // PrometheusModule.register here mounts its OWN controller at
    // `path` unless we opt out. We DO opt out — by providing the
    // `controller` field with our guarded controller. That way the
    // library still wires up the default-metrics collector for us,
    // but the scrape endpoint flows through our bearer guard + global
    // /api/v1 prefix.
    PrometheusModule.register({
      defaultMetrics: { enabled: true },
      defaultLabels: { app: 'bondzi-api' },
      controller: MetricsController,
    }),
  ],
  controllers: [MetricsController],
  providers: [
    ...metricProviders,
    MetricsService,
    MetricsBearerGuard,
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
  ],
  exports: [MetricsService, ...metricProviders],
})
export class ObservabilityModule {}
