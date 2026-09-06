import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
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
  RefundResult,
  RefundTransactionInput,
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

  /**
   * Issue a Paystack refund for a settled transaction. Paystack's
   * `/refund` endpoint accepts the transaction reference and an
   * optional amount/currency/customer_note. The response carries a
   * status: 'pending' on first call, then transitions through
   * 'processed' via the refund.processed webhook.
   *
   * Idempotency: Paystack returns 200 with the existing refund row
   * when called twice for the same reference — so callers can safely
   * retry. We translate any non-2xx into RefundResult{status:'failed'}
   * rather than throwing, so the alarm path can decide whether to
   * leave the attempt PAID (visible in the duplicate-Plus admin
   * filter) or proceed to mark REFUNDED.
   */
  async refundTransaction(
    input: RefundTransactionInput,
  ): Promise<RefundResult> {
    type PaystackRefundResponse = {
      status?: boolean;
      message?: string;
      data?: {
        id?: number | string;
        status?: string;
      };
    };
    try {
      const body: Record<string, unknown> = {
        transaction: input.reference,
      };
      if (input.amountMinor !== undefined) body.amount = input.amountMinor;
      if (input.currency) body.currency = input.currency;
      if (input.reason) body.customer_note = input.reason.slice(0, 200);
      const response = await this.http.post<PaystackRefundResponse>(
        '/refund',
        body,
      );
      const data = response.data?.data;
      const statusRaw = (data?.status ?? '').toString().toLowerCase();
      // Paystack ships statuses 'pending' | 'processing' | 'processed'
      // | 'failed'. We collapse the first two into our 'pending'.
      let status: RefundResult['status'] = 'pending';
      if (statusRaw === 'processed') status = 'processed';
      else if (statusRaw === 'failed') status = 'failed';
      return {
        status,
        providerRefundId: data?.id != null ? String(data.id) : null,
        raw: response.data,
      };
    } catch (err) {
      this.logger.error(
        `[paystack] refundTransaction ref=${input.reference} failed: ${(err as Error).message}`,
      );
      return { status: 'failed', providerRefundId: null };
    }
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

    // CRITICAL: dedup is keyed by (provider, eventId). The previous
    // fallback `data.reference` could collide because a single
    // transaction emits MULTIPLE distinct webhooks under the same
    // reference (charge.success, then subscription.create, then
    // invoice.payment_failed on retry). They'd be persisted as
    // "duplicate" of each other and only the first would process.
    //
    // The fixed shape:
    //   1. Prefer the provider's own id (payload.id or data.id) when
    //      present — Paystack populates this for nearly every event.
    //   2. When absent, qualify with eventName so two events for the
    //      same reference don't collide.
    //   3. As a last-resort tiebreaker, hash the raw body so two
    //      semantically-distinct events with the same envelope still
    //      differ in id. Use sha256 truncated to 16 hex chars (64 bits)
    //      — collision-resistant for the volume we'd ever see and
    //      cheap to compute.
    //   4. NO `Date.now()` fallback — that made retries of the same
    //      event uniquely-id'd and broke dedup outright.
    const explicitId =
      (payload.id as string | number | undefined) ??
      (data.id as string | number | undefined);
    const reference = data.reference as string | undefined;
    const bodyHash = createHash('sha256')
      .update(bodyStr)
      .digest('hex')
      .slice(0, 16);
    const eventId =
      explicitId !== undefined
        ? String(explicitId)
        : reference
          ? `${eventName}:${reference}:${bodyHash}`
          : `${eventName}:${bodyHash}`;

    // Provider-claimed event timestamp. Used by WebhookHandlerService
    // to drop replays older than the freshness window. Falls back
    // through paid_at / created_at / now; Paystack always sets one
    // of these on real events.
    const claimedAtRaw =
      (data.paid_at as string | undefined) ??
      (data.created_at as string | undefined) ??
      (data.transaction_date as string | undefined);
    const claimedAt = claimedAtRaw ? new Date(claimedAtRaw) : undefined;

    return {
      eventId,
      type: PAYSTACK_EVENT_TO_NORMALIZED[eventName] ?? 'unknown',
      userId: (metadata.userId as string | undefined) ?? undefined,
      reference,
      providerPlanCode:
        (data.plan_code as string | undefined) ??
        (plan.plan_code as string | undefined) ??
        (metadata.providerPlanCode as string | undefined),
      customerId: (customer.customer_code as string | undefined) ?? undefined,
      customerEmail: (customer.email as string | undefined) ?? undefined,
      planId: (metadata.planId as string | undefined) ?? undefined,
      intervalHint:
        (metadata.interval as string | undefined) ??
        (metadata.cadence as string | undefined) ??
        undefined,
      subscriptionId:
        (data.subscription_code as string | undefined) ??
        (subscription.subscription_code as string | undefined),
      amountMinor: data.amount !== undefined ? Number(data.amount) : undefined,
      currency: (data.currency as string | undefined) ?? undefined,
      nextPaymentDate: data.next_payment_date
        ? new Date(data.next_payment_date as string)
        : undefined,
      claimedAt,
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
