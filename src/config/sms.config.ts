import { registerAs } from '@nestjs/config';

export default registerAs('sms', () => ({
  atUsername: process.env.AT_USERNAME as string,
  atApiKey: process.env.AT_API_KEY as string,
  atSenderId: process.env.AT_SENDER_ID ?? 'PASSMASTER',
}));
