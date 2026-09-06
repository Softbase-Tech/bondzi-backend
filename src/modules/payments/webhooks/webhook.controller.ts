import {
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Logger } from '@nestjs/common';
import { Public } from '../../../common/decorators/public.decorator';
import { AdminAlertService } from '../../mail/admin-alert.service';
import { PaymentProviderRegistry } from '../providers/payment-provider.registry';
import { WebhookHandlerService } from './webhook-handler.service';

// main.ts wires express.raw() so the unparsed body is on req.rawBody.
interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/**
 * One route per provider: POST /payments/webhooks/paystack (Stripe, Flutterwave
 * etc. each point their delivery URL at their own path). The controller
 * resolves the matching PaymentProvider from the registry, delegates signature
 * verification + event parsing to it, and hands the normalized event to the
 * shared handler.
 *
 * 200 vs 5xx contract: we return 200 when the event was successfully
 * dispatched OR when it's a genuine duplicate (already-processed). We
 * return 5xx (let the handler throw) when processing FAILED — so the
 * provider retries according to its policy. Idempotency at the
 * `(provider, event_id)` unique constraint means a retry can't
 * double-process; combined with the handler's "retry unprocessed row"
 * branch, this closes the silent revenue-loss path where a transient
 * DB hiccup left `processed=false` and Paystack never retried.
 */
@ApiTags('payments-webhooks')
@Controller('payments/webhooks')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);
  /** Last signature-rejection alert per provider — 1 email/hour cap. */
  private lastSigAlertAt = new Map<string, number>();

  constructor(
    private readonly providers: PaymentProviderRegistry,
    private readonly handler: WebhookHandlerService,
    private readonly adminAlert: AdminAlertService,
  ) {}

  @Public()
  @Post(':provider')
  @ApiExcludeEndpoint()
  @ApiOperation({
    summary: 'Inbound webhook receiver — provider-scoped.',
  })
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 100, ttl: 60_000 } })
  async receive(
    @Param('provider') providerName: string,
    @Req() req: RawBodyRequest,
  ): Promise<{ status: string }> {
    if (!this.providers.has(providerName)) {
      throw new ForbiddenException('Unknown provider');
    }
    const provider = this.providers.get(providerName);

    const rawBody = req.rawBody;
    if (!rawBody) throw new ForbiddenException('Missing raw body');

    if (!provider.verifyWebhookSignature(rawBody, req.headers)) {
      // A rejected signature is rejected BEFORE anything is persisted,
      // which historically made a misconfigured secret completely
      // silent: the provider kept sending money events and this
      // endpoint kept 403ing them into the void. Keep the 403 (never
      // process an unverified payload) but make the condition loudly
      // visible — logged every time, emailed at most once an hour.
      this.logger.error(
        `[webhook] ${providerName} signature REJECTED — payload ${rawBody.length}B. ` +
          `If this is Paystack, the configured secret key does not match the ` +
          `account sending events (or someone is probing the endpoint).`,
      );
      const now = Date.now();
      const last = this.lastSigAlertAt.get(providerName) ?? 0;
      if (now - last > 60 * 60 * 1000) {
        this.lastSigAlertAt.set(providerName, now);
        void this.adminAlert
          .send(
            `Webhook signature rejected (${providerName})`,
            [
              `A ${providerName} webhook was rejected for an invalid signature.`,
              'No payment events are being processed while this persists.',
              '',
              'Check: the deployed PAYSTACK_SECRET_KEY_GH must be the SAME',
              'live secret key as the Paystack account sending webhooks, and',
              'the dashboard webhook URL must point at this environment.',
            ].join('\n'),
          )
          .catch(() => undefined);
      }
      throw new ForbiddenException('Invalid signature');
    }

    const event = provider.parseWebhookEvent(rawBody);
    await this.handler.process(providerName, event);
    return { status: 'ok' };
  }
}
