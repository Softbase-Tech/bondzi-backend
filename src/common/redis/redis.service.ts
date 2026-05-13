import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

/**
 * Thin typed wrapper around ioredis with graceful-degradation semantics.
 * If Redis is unreachable, cache reads return null and writes are no-ops —
 * callers fall back to DB. The app never crashes on a Redis outage.
 */
@Injectable()
export class RedisService {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  get raw(): Redis {
    return this.client;
  }

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      this.logger.warn(
        `redis.getJson(${key}) failed: ${(err as Error).message}`,
      );
      return null;
    }
  }

  async setJson(
    key: string,
    value: unknown,
    ttlSeconds?: number,
  ): Promise<void> {
    try {
      const payload = JSON.stringify(value);
      if (ttlSeconds && ttlSeconds > 0) {
        await this.client.set(key, payload, 'EX', ttlSeconds);
      } else {
        await this.client.set(key, payload);
      }
    } catch (err) {
      this.logger.warn(
        `redis.setJson(${key}) failed: ${(err as Error).message}`,
      );
    }
  }

  async del(key: string | string[]): Promise<void> {
    try {
      const keys = Array.isArray(key) ? key : [key];
      if (keys.length) await this.client.del(...keys);
    } catch (err) {
      this.logger.warn(`redis.del failed: ${(err as Error).message}`);
    }
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    try {
      const count = await this.client.incr(key);
      if (count === 1 && ttlSeconds) {
        await this.client.expire(key, ttlSeconds);
      }
      return count;
    } catch (err) {
      this.logger.warn(`redis.incr(${key}) failed: ${(err as Error).message}`);
      return 0;
    }
  }

  async incrByFloat(
    key: string,
    value: number,
    ttlSeconds?: number,
  ): Promise<number> {
    try {
      const v = await this.client.incrbyfloat(key, value);
      if (ttlSeconds) await this.client.expire(key, ttlSeconds);
      return parseFloat(v);
    } catch (err) {
      this.logger.warn(
        `redis.incrByFloat(${key}) failed: ${(err as Error).message}`,
      );
      return 0;
    }
  }

  async setNx(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    try {
      const res = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
      return res === 'OK';
    } catch (err) {
      this.logger.warn(`redis.setNx(${key}) failed: ${(err as Error).message}`);
      return false;
    }
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (err) {
      this.logger.warn(`redis.get(${key}) failed: ${(err as Error).message}`);
      return null;
    }
  }

  // Named aliases so call-sites read naturally for string payloads.
  async getString(key: string): Promise<string | null> {
    return this.get(key);
  }

  async setString(
    key: string,
    value: string,
    ttlSeconds?: number,
  ): Promise<void> {
    try {
      if (ttlSeconds && ttlSeconds > 0) {
        await this.client.set(key, value, 'EX', ttlSeconds);
      } else {
        await this.client.set(key, value);
      }
    } catch (err) {
      this.logger.warn(
        `redis.setString(${key}) failed: ${(err as Error).message}`,
      );
    }
  }

  async ping(): Promise<boolean> {
    try {
      const r = await this.client.ping();
      return r === 'PONG';
    } catch {
      return false;
    }
  }
}
