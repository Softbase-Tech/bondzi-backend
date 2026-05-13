import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisService } from './redis.service';
import { REDIS_CLIENT } from './redis.constants';

export { REDIS_CLIENT };

/**
 * Global Redis module. Every module that needs Redis injects RedisService
 * (typed wrapper) or the REDIS_CLIENT token directly (for ioredis primitives).
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('redis.url') as string;
        const tls = config.get<boolean>('redis.tls') === true;
        const client = new Redis(url, {
          tls: tls ? {} : undefined,
          maxRetriesPerRequest: null,
          enableReadyCheck: true,
          lazyConnect: false,
        });
        client.on('error', (err) => {
          console.error('[redis] error', err.message);
        });
        return client;
      },
      inject: [ConfigService],
    },
    RedisService,
  ],
  exports: [REDIS_CLIENT, RedisService],
})
export class RedisModule {}
