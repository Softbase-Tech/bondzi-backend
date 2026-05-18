import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { register } from 'prom-client';
import { Public } from '../decorators/public.decorator';
import { MetricsBearerGuard } from './metrics.guard';

/**
 * `/api/v1/internal/metrics` — Prometheus scrape endpoint.
 *
 * @Public skips JwtAuthGuard (Grafana's hosted scraper doesn't have a
 *   user session). The MetricsBearerGuard takes over with a constant-
 *   time token check, AND nginx separately allowlists Grafana's
 *   published scrape IPs in bondzi.conf.
 *
 * Returns plain-text Prometheus exposition format — emitted by
 * `prom-client.register.metrics()`. No DB, no Redis, no cache lookups;
 * all data lives in in-process counters. p95 latency: ~1ms.
 */
@Controller('internal/metrics')
@UseGuards(MetricsBearerGuard)
export class MetricsController {
  @Get()
  @Public()
  async index(@Res({ passthrough: true }) res: Response): Promise<string> {
    res.setHeader('Content-Type', register.contentType);
    return register.metrics();
  }
}
