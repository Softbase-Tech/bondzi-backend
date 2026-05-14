import { Test } from '@nestjs/testing';
import { RedisService } from './redis.service';
import { REDIS_CLIENT } from './redis.constants';

/**
 * RedisService promises graceful degradation: every method must swallow a
 * client-level throw and return the documented no-data sentinel
 * (`null` / `false` / `0` / void). If that contract is broken the whole
 * app crashes the first time Redis dies. These tests pin the happy path
 * and the failure path side-by-side.
 */

describe('RedisService', () => {
  let service: RedisService;
  let client: {
    get: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
    incr: jest.Mock;
    incrbyfloat: jest.Mock;
    expire: jest.Mock;
    ping: jest.Mock;
  };

  beforeEach(async () => {
    client = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      incr: jest.fn(),
      incrbyfloat: jest.fn(),
      expire: jest.fn(),
      ping: jest.fn(),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [RedisService, { provide: REDIS_CLIENT, useValue: client }],
    }).compile();
    service = moduleRef.get(RedisService);
  });

  // --------------------------- getJson / setJson ---------------------------

  it('getJson returns the parsed payload on a hit', async () => {
    client.get.mockResolvedValueOnce('{"a":1}');
    expect(await service.getJson('k')).toEqual({ a: 1 });
  });

  it('getJson returns null on a miss', async () => {
    client.get.mockResolvedValueOnce(null);
    expect(await service.getJson('k')).toBeNull();
  });

  it('getJson swallows a client throw and returns null', async () => {
    client.get.mockRejectedValueOnce(new Error('boom'));
    expect(await service.getJson('k')).toBeNull();
  });

  it('setJson serialises with EX when a TTL is given', async () => {
    await service.setJson('k', { a: 1 }, 60);
    expect(client.set).toHaveBeenCalledWith('k', '{"a":1}', 'EX', 60);
  });

  it('setJson serialises without TTL when ttlSeconds is omitted', async () => {
    await service.setJson('k', { a: 1 });
    expect(client.set).toHaveBeenCalledWith('k', '{"a":1}');
  });

  // ---------------------------------- incr ----------------------------------

  it('incr sets the TTL only on the first increment (count === 1)', async () => {
    client.incr.mockResolvedValueOnce(1);
    await service.incr('k', 60);
    expect(client.expire).toHaveBeenCalledWith('k', 60);

    client.incr.mockResolvedValueOnce(2);
    client.expire.mockClear();
    await service.incr('k', 60);
    expect(client.expire).not.toHaveBeenCalled();
  });

  it('incr returns 0 if the client throws (no exception bubbles)', async () => {
    client.incr.mockRejectedValueOnce(new Error('down'));
    expect(await service.incr('k')).toBe(0);
  });

  // ---------------------------------- setNx ---------------------------------

  it('setNx returns true only when the SET responded "OK"', async () => {
    client.set.mockResolvedValueOnce('OK');
    expect(await service.setNx('k', 'v', 60)).toBe(true);
    client.set.mockResolvedValueOnce(null);
    expect(await service.setNx('k', 'v', 60)).toBe(false);
  });

  it('setNx swallows a thrown error and returns false', async () => {
    client.set.mockRejectedValueOnce(new Error('boom'));
    expect(await service.setNx('k', 'v', 60)).toBe(false);
  });

  // ---------------------------------- del -----------------------------------

  it('del accepts a single key or an array', async () => {
    await service.del('a');
    expect(client.del).toHaveBeenCalledWith('a');
    await service.del(['a', 'b']);
    expect(client.del).toHaveBeenLastCalledWith('a', 'b');
  });

  it('del swallows empty-array calls without throwing', async () => {
    await service.del([]);
    expect(client.del).not.toHaveBeenCalled();
  });

  // ---------------------------------- ping ----------------------------------

  it('ping returns true only on a "PONG" reply', async () => {
    client.ping.mockResolvedValueOnce('PONG');
    expect(await service.ping()).toBe(true);
    client.ping.mockResolvedValueOnce('OK');
    expect(await service.ping()).toBe(false);
    client.ping.mockRejectedValueOnce(new Error('down'));
    expect(await service.ping()).toBe(false);
  });

  // ---------------------------- incrByFloat ----------------------------

  it('incrByFloat parses the string reply into a number', async () => {
    client.incrbyfloat.mockResolvedValueOnce('12.5');
    expect(await service.incrByFloat('k', 0.5)).toBe(12.5);
  });

  it('incrByFloat returns 0 when the client throws', async () => {
    client.incrbyfloat.mockRejectedValueOnce(new Error('down'));
    expect(await service.incrByFloat('k', 1)).toBe(0);
  });
});
