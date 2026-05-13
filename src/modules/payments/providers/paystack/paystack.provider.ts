import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import axios, { AxiosInstance } from 'axios';
import { BillingInterval } from '../../../../common/types/enums';
import {
  CancelSubscriptionInput,
  CheckoutSession,
  CreatePlanInput,
  InitCheckoutInput,
  NormalizedWebhookEvent,
  NormalizedWebhookEventType,
  PaymentProvider,
  ProviderPlan,
  VerifiedTransaction,
} from '../payment-provider.interface';

const INTERVAL_TO_PAYSTACK: Record<BillingInterval, string> = {
  [BillingInterval.MONTHLY]: 'monthly',
  [BillingInterval.SIX_MONTH]: 'biannually',
  [BillingInterval.ANNUAL]: 'annually',
};

const PAYSTACK_EVENT_TO_NORMALIZED: Record<string, NormalizedWebhookEventType> =
  {
    'charge.success': 'charge.success',
    'subscription.create': 'subscription.create',
    'subscription.disable': 'subscription.disable',
    'subscription.not_renew': 'subscription.not_renew',
    'invoice.payment_failed': 'invoice.failed',
    'invoice.update': 'invoice.update',
    'refund.processed': 'refund.processed',
  };

/**
 * Paystack adapter. Everything gateway-specific lives here — the REST calls,
 * the HMAC-SHA512 signature scheme, the interval naming, the webhook event
 * name mapping. Callers see only the normalized PaymentProvider surface.
 */
@Injectable()
export class PaystackProvider implements PaymentProvider {
  readonly name = 'paystack';
  private readonly logger = new Logger(PaystackProvider.name);
  private readonly http: AxiosInstance;
  private readonly secret: string;

  constructor(private readonly config: ConfigService) {
    this.secret = this.config.get<string>('paystack.gh.secretKey') as string;
    this.http = axios.create({
      baseURL:
        this.config.get<string>('paystack.apiBaseUrl') ??
        'https://api.paystack.co',
      headers: {
        Authorization: `Bearer ${this.secret}`,
        'Content-Type': 'application/json',
      },
      timeout: 10_000,
    });
  }

  async createPlan(input: CreatePlanInput): Promise<ProviderPlan> {
    try {
      const res = await this.http.post<{
        data: { plan_code: string; id: number };
      }>('/plan', {
        name: input.name,
        amount: input.amountMinor,
        interval: INTERVAL_TO_PAYSTACK[input.interval],
        currency: input.currency,
      });
      return { providerPlanCode: res.data.data.plan_code, raw: res.data.data };
    } catch (err) {
      this.logger.error(
        `Paystack createPlan failed (${input.name}): ${(err as Error).message}`,
      );
      throw new InternalServerErrorException('Paystack plan creation failed');
    }
  }

  async initializeCheckout(input: InitCheckoutInput): Promise<CheckoutSession> {
    try {
      const res = await this.http.post<{
        data: {
          authorization_url: string;
          access_code: string;
          reference: string;
        };
      }>('/transaction/initialize', {
        email: input.user.email,
        amount: input.amountMinor,
        plan: input.providerPlanCode || undefined,
        reference: input.reference,
        callback_url: this.config.get<string>('paystack.callbackUrl'),
        metadata: input.metadata,
        currency: input.currency,
        channels: ['card', 'mobile_money', 'bank_transfer'],
      });
      return {
        authorizationUrl: res.data.data.authorization_url,
        reference: res.data.data.reference,
        raw: res.data.data,
      };
    } catch (err) {
      this.logger.error(
        `Paystack initialize failed: ${(err as Error).message}`,
      );
      throw new InternalServerErrorException('Paystack initialisation failed');
    }
  }

  async verifyTransaction(reference: string): Promise<VerifiedTransaction> {
    const res = await this.http.get<{
      data: {
        status: string;
        amount: number;
        currency: string;
        reference: string;
        customer: { customer_code: string; email: string };
        plan?: { plan_code?: string };
        metadata?: Record<string, unknown>;
      };
    }>(`/transaction/verify/${encodeURIComponent(reference)}`);
    const data = res.data.data;
    return {
      status: this.mapTxStatus(data.status),
      reference: data.reference,
      amountMinor: Number(data.amount ?? 0),
      currency: data.currency ?? 'GHS',
      customerId: data.customer?.customer_code ?? null,
      providerPlanCode: data.plan?.plan_code ?? null,
      raw: data,
    };
  }

  async cancelSubscription(input: CancelSubscriptionInput): Promise<void> {
    await this.http.post('/subscription/disable', {
      code: input.subscriptionId,
      token: input.customerId ?? '',
    });
  }

  verifyWebhookSignature(
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>,
  ): boolean {
    const header = headers['x-paystack-signature'];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature) return false;
    const payload = Buffer.isBuffer(rawBody)
      ? rawBody
      : Buffer.from(rawBody, 'utf8');
    const expected = createHmac('sha512', this.secret)
      .update(payload)
      .digest('hex');
    if (expected.length !== signature.length) return false;
    try {
      return timingSafeEqual(
        Buffer.from(expected, 'hex'),
        Buffer.from(signature, 'hex'),
      );
    } catch {
      return false;
    }
  }

  parseWebhookEvent(rawBody: Buffer | string): NormalizedWebhookEvent {
    const bodyStr = Buffer.isBuffer(rawBody)
      ? rawBody.toString('utf8')
      : rawBody;
    const payload = JSON.parse(bodyStr) as Record<string, unknown>;
    const eventName =
      typeof payload.event === 'string' ? payload.event : 'unknown';
    const data = (payload.data ?? {}) as Record<string, unknown>;
    const metadata = (data.metadata ?? {}) as Record<string, unknown>;
    const customer = (data.customer ?? {}) as Record<string, unknown>;
    const subscription = (data.subscription ?? {}) as Record<string, unknown>;
    const plan = (data.plan ?? {}) as Record<string, unknown>;

    const eventId =
      (payload.id as string | number | undefined) ??
      (data.id as string | number | undefined) ??
      (data.reference as string | undefined) ??
      `${eventName}-${Date.now()}`;

    return {
      eventId: String(eventId),
      type: PAYSTACK_EVENT_TO_NORMALIZED[eventName] ?? 'unknown',
      userId: (metadata.userId as string | undefined) ?? undefined,
      reference: (data.reference as string | undefined) ?? undefined,
      providerPlanCode:
        (data.plan_code as string | undefined) ??
        (plan.plan_code as string | undefined) ??
        (metadata.providerPlanCode as string | undefined),
      customerId: (customer.customer_code as string | undefined) ?? undefined,
      subscriptionId:
        (data.subscription_code as string | undefined) ??
        (subscription.subscription_code as string | undefined),
      amountMinor: data.amount !== undefined ? Number(data.amount) : undefined,
      currency: (data.currency as string | undefined) ?? undefined,
      nextPaymentDate: data.next_payment_date
        ? new Date(data.next_payment_date as string)
        : undefined,
      raw: payload,
    };
  }

  private mapTxStatus(status: string): 'success' | 'failed' | 'pending' {
    if (status === 'success') return 'success';
    if (status === 'failed' || status === 'abandoned' || status === 'reversed')
      return 'failed';
    return 'pending';
  }
}
