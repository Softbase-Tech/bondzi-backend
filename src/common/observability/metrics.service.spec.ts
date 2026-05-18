import { MetricsService } from './metrics.service';

/**
 * Tests the route-label normalizer. This is the single defense against
 * a high-cardinality label explosion that would blow past Grafana
 * Cloud's 10k-series free-tier cap — every unique URL path tail
 * becomes a new time series in Prometheus.
 */

describe('MetricsService.routeLabel', () => {
  it('strips the query string', () => {
    expect(MetricsService.routeLabel('/users/me?include=profile')).toBe(
      '/users/me',
    );
  });

  it('collapses UUIDs into :uuid', () => {
    expect(
      MetricsService.routeLabel(
        '/exams/9b5e0e10-3f7a-4d2a-9b3e-19c6d0e9a7f0/results',
      ),
    ).toBe('/exams/:uuid/results');
  });

  it('collapses long numeric IDs into :id', () => {
    expect(MetricsService.routeLabel('/notifications/12345/read')).toBe(
      '/notifications/:id/read',
    );
  });

  it('leaves short numeric segments alone (likely route-meaningful)', () => {
    expect(MetricsService.routeLabel('/api/v1/health')).toBe('/api/v1/health');
  });

  it('truncates absurdly long paths to bound label length', () => {
    const long = '/x'.repeat(200);
    expect(MetricsService.routeLabel(long).length).toBeLessThanOrEqual(120);
  });
});
