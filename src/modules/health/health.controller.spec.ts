import { Test } from '@nestjs/testing';
import { HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { RedisService } from '../../common/redis/redis.service';

/**
 * The Terminus check should run both a DB ping and a Redis ping. Tests below
 * verify the wiring — DB indicator gets called, Redis gets a `ping`, both
 * results land in the `health.check()` aggregator.
 */
describe('HealthController', () => {
  let controller: HealthController;
  let health: { check: jest.Mock };
  let db: { pingCheck: jest.Mock };
  let redis: { ping: jest.Mock };

  beforeEach(async () => {
    health = {
      check: jest.fn(async (checks: Array<() => Promise<unknown>>) => {
        for (const c of checks) await c();
        return { status: 'ok' };
      }),
    };
    db = {
      pingCheck: jest.fn().mockResolvedValue({ database: { status: 'up' } }),
    };
    redis = { ping: jest.fn().mockResolvedValue(true) };

    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: HealthCheckService, useValue: health },
        { provide: TypeOrmHealthIndicator, useValue: db },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();
    controller = moduleRef.get(HealthController);
  });

  it('runs the DB pingCheck and the Redis ping inside the Terminus aggregator', async () => {
    await controller.check();
    expect(db.pingCheck).toHaveBeenCalledWith('database', { timeout: 1500 });
    expect(redis.ping).toHaveBeenCalled();
  });

  it('emits redis:"up" when ping resolves truthy', async () => {
    let redisResult: { redis?: { status: string } } | undefined;
    health.check.mockImplementationOnce(
      async (checks: Array<() => Promise<{ redis?: { status: string } }>>) => {
        for (const c of checks) {
          const r = await c();
          if ('redis' in r) redisResult = r;
        }
        return { status: 'ok' };
      },
    );
    await controller.check();
    expect(redisResult?.redis?.status).toBe('up');
  });

  it('emits redis:"down" when ping resolves falsy', async () => {
    redis.ping.mockResolvedValueOnce(false);
    let redisResult: { redis?: { status: string } } | undefined;
    health.check.mockImplementationOnce(
      async (checks: Array<() => Promise<{ redis?: { status: string } }>>) => {
        for (const c of checks) {
          const r = await c();
          if ('redis' in r) redisResult = r;
        }
        return { status: 'ok' };
      },
    );
    await controller.check();
    expect(redisResult?.redis?.status).toBe('down');
  });
});
