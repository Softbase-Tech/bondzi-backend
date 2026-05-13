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
import { Public } from '../../../common/decorators/public.decorator';
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
 * Always returns 200 on authentic events — a non-200 triggers provider retries
 * and double-processing. Idempotency is enforced by (provider, event_id) in
 * payment_events.
 */
@ApiTags('payments-webhooks')
@Controller('payments/webhooks')
export class WebhookController {
  constructor(
    private readonly providers: PaymentProviderRegistry,
    private readonly handler: WebhookHandlerService,
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
      throw new ForbiddenException('Invalid signature');
    }

    const event = provider.parseWebhookEvent(rawBody);
    await this.handler.process(providerName, event);
    return { status: 'ok' };
  }
}
