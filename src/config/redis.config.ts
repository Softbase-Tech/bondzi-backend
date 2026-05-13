import { registerAs } from '@nestjs/config';

export default registerAs('redis', () => ({
  url: process.env.REDIS_URL as string,
  tls: process.env.REDIS_TLS === 'true',
}));
