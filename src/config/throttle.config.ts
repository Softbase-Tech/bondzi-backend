import { registerAs } from '@nestjs/config';

export default registerAs('throttle', () => ({
  shortLimit: parseInt(process.env.THROTTLE_SHORT_LIMIT ?? '30', 10),
  shortTtl: parseInt(process.env.THROTTLE_SHORT_TTL ?? '10', 10),
  longLimit: parseInt(process.env.THROTTLE_LONG_LIMIT ?? '200', 10),
  longTtl: parseInt(process.env.THROTTLE_LONG_TTL ?? '60', 10),
}));
