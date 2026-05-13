import { registerAs } from '@nestjs/config';

/**
 * Paystack adapter credentials. Plan codes now live in the
 * `subscription_plan` table (managed via /admin/plans), so env vars only
 * hold auth + callback info.
 */
export default registerAs('paystack', () => ({
  gh: {
    secretKey: process.env.PAYSTACK_SECRET_KEY_GH as string,
    publicKey: process.env.PAYSTACK_PUBLIC_KEY_GH as string,
  },
  webhookSecret: process.env.PAYSTACK_WEBHOOK_SECRET as string,
  callbackUrl: process.env.PAYSTACK_CALLBACK_URL as string,
  apiBaseUrl: 'https://api.paystack.co',
}));
