import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WebhookController } from './webhook.controller';
import { PaymentProviderRegistry } from '../providers/payment-provider.registry';
import { WebhookHandlerService } from './webhook-handler.service';

/**
 * The controller is the security gate. Three things must hold:
 *   1. Unknown providers are rejected with 403 (no path to handler).
 *   2. Missing raw body is rejected with 403 — without it we can't verify
 *      the HMAC, so we must not parse the event.
 *   3. A bad signature is rejected with 403 BEFORE the handler runs.
 *   4. A valid event flows through and returns { status: 'ok' }.
 */

describe('WebhookController', () => {
  let controller: WebhookController;
  let providers: { has: jest.Mock; get: jest.Mock };
  let provider: {
    verifyWebhookSignature: jest.Mock;
    parseWebhookEvent: jest.Mock;
  };
  let handler: { process: jest.Mock };

  beforeEach(async () => {
    provider = {
      verifyWebhookSignature: jest.fn(),
      parseWebhookEvent: jest.fn(),
    };
    providers = {
      has: jest.fn(() => true),
      get: jest.fn(() => provider),
    };
    handler = { process: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      controllers: [WebhookController],
      providers: [
        { provide: PaymentProviderRegistry, useValue: providers },
        { provide: WebhookHandlerService, useValue: handler },
      ],
    }).compile();
    controller = moduleRef.get(WebhookController);
  });

  function makeReq(
    rawBody: Buffer | undefined,
    headers: Record<string, string> = {},
  ) {
    return { rawBody, headers } as never;
  }

  it('rejects unknown providers with 403 before touching the handler', async () => {
    providers.has.mockReturnValueOnce(false);
    await expect(
      controller.receive('totally-fake-provider', makeReq(Buffer.from('{}'))),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(handler.process).not.toHaveBeenCalled();
  });

  it('rejects missing raw body with 403 (can not verify signature without it)', async () => {
    await expect(
      controller.receive('paystack', makeReq(undefined)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(provider.verifyWebhookSignature).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature with 403 BEFORE handler runs', async () => {
    provider.verifyWebhookSignature.mockReturnValueOnce(false);
    await expect(
      controller.receive(
        'paystack',
        makeReq(Buffer.from('{"x":1}'), { 'x-paystack-signature': 'bad' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(provider.parseWebhookEvent).not.toHaveBeenCalled();
    expect(handler.process).not.toHaveBeenCalled();
  });

  it('parses, dispatches, and returns { status: "ok" } on a valid event', async () => {
    provider.verifyWebhookSignature.mockReturnValueOnce(true);
    provider.parseWebhookEvent.mockReturnValueOnce({
      type: 'charge.success',
      eventId: 'evt_1',
    });
    handler.process.mockResolvedValueOnce({ processed: true });

    const out = await controller.receive(
      'paystack',
      makeReq(Buffer.from('{"x":1}'), { 'x-paystack-signature': 'sig' }),
    );

    expect(handler.process).toHaveBeenCalledWith(
      'paystack',
      expect.objectContaining({ type: 'charge.success' }),
    );
    expect(out).toEqual({ status: 'ok' });
  });
});
