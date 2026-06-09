import { BillingInterval } from '../../../common/types/enums';

/**
 * Provider-agnostic payment abstraction. Every gateway (Paystack today,
 * Stripe / Flutterwave later) implements this. Business code never sees
 * gateway-shaped payloads — only the normalized types below.
 *
 * Each plan row picks its provider via the `provider` column; the registry
 * resolves the implementation at runtime, so swapping providers is one
 * database update + one new adapter class.
 */
export interface PaymentProvider {
  /** Machine name — must match the value stored on subscription_plan.provider. */
  readonly name: string;

  createPlan(input: CreatePlanInput): Promise<ProviderPlan>;
  initializeCheckout(input: InitCheckoutInput): Promise<CheckoutSession>;
  verifyTransaction(reference: string): Promise<VerifiedTransaction>;
  cancelSubscription(input: CancelSubscriptionInput): Promise<void>;
  /**
   * Issue a refund for a settled transaction. Idempotent at the
   * provider level — Paystack returns 200 with an "already refunded"
   * status when called twice. Used by the auto-refund alarm paths
   * (duplicate-Plus charge, cancelled-then-debit). The caller must
   * mark its own attempt as REFUNDED only after this promise
   * resolves successfully.
   */
  refundTransaction(input: RefundTransactionInput): Promise<RefundResult>;

  verifyWebhookSignature(
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>,
  ): boolean;
  parseWebhookEvent(rawBody: Buffer | string): NormalizedWebhookEvent;
}

export interface CreatePlanInput {
  name: string;
  amountMinor: number; // pesewas / cents — always the currency's minor unit
  currency: string; // 'GHS', 'USD', ...
  interval: BillingInterval;
}

export interface ProviderPlan {
  providerPlanCode: string;
  raw?: unknown;
}

export interface InitCheckoutInput {
  user: { id: string; email: string };
  providerPlanCode: string;
  amountMinor: number;
  currency: string;
  reference: string;
  metadata: Record<string, unknown>;
}

export interface CheckoutSession {
  authorizationUrl: string;
  reference: string;
  raw?: unknown;
}

export interface VerifiedTransaction {
  status: 'success' | 'failed' | 'pending';
  reference: string;
  amountMinor: number;
  currency: string;
  customerId?: string | null;
  subscriptionId?: string | null;
  providerPlanCode?: string | null;
  raw?: unknown;
}

export interface CancelSubscriptionInput {
  subscriptionId: string;
  customerId?: string | null;
}

export interface RefundTransactionInput {
  /** Server-issued reference (the same one we stamped on payment_attempts). */
  reference: string;
  /** Amount in pesewas. Omit to refund the full original charge. */
  amountMinor?: number;
  /** Currency — defaults to GHS. */
  currency?: string;
  /** Short reason recorded with the refund — surfaces in the provider dashboard. */
  reason?: string;
}

export interface RefundResult {
  /**
   * Provider-side refund status. 'pending' means the gateway accepted
   * the refund but settlement may take days; 'processed' means money
   * has moved (rare on first call — most providers go pending → processed
   * via a refund.processed webhook). 'failed' means the provider
   * rejected the refund request — caller must NOT mark the attempt
   * REFUNDED in that case.
   */
  status: 'pending' | 'processed' | 'failed';
  providerRefundId?: string | null;
  raw?: unknown;
}

/**
 * Normalized webhook event shape. Each provider maps its raw event names
 * into these, so WebhookHandlerService never branches on provider.
 */
export type NormalizedWebhookEventType =
  | 'charge.success'
  | 'subscription.create'
  | 'subscription.disable'
  | 'subscription.not_renew'
  | 'invoice.failed'
  | 'invoice.update'
  | 'refund.processed'
  | 'unknown';

export interface NormalizedWebhookEvent {
  /** Stable, provider-scoped event id — used as the idempotency key. */
  eventId: string;
  type: NormalizedWebhookEventType;
  userId?: string;
  reference?: string;
  providerPlanCode?: string;
  customerId?: string;
  subscriptionId?: string;
  amountMinor?: number;
  currency?: string;
  nextPaymentDate?: Date;
  /**
   * The provider-claimed event timestamp (paid_at / created_at). The
   * webhook handler enforces a freshness window against this so a
   * captured-and-replayed body from a year ago can't pass even if its
   * HMAC is still valid AND its eventId hasn't been seen yet (e.g.
   * after a DB wipe). Provider must extract from the signed body.
   */
  claimedAt?: Date;
  /** Raw payload kept for audit/debug; never consumed by handlers. */
  raw: Record<string, unknown>;
}

/**
 * DI token for the array of registered providers. Register providers via a
 * factory in PaymentsModule that injects each concrete class.
 */
export const PAYMENT_PROVIDERS = Symbol('PAYMENT_PROVIDERS');
