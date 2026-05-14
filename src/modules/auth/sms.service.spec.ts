import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AfricasTalkingSmsProvider } from './sms.service';

/**
 * AfricasTalkingSmsProvider. The provider is initialised lazily, so we can
 * exercise the "not configured" branch by leaving AT_API_KEY blank.
 *
 *  - When username/apiKey are blank, send() must log + no-op (NEVER throw).
 *    Otherwise dev/tests crash on first OTP send.
 *  - A real provider throw propagates so the OTP service can return 502.
 */

describe('AfricasTalkingSmsProvider', () => {
  let service: AfricasTalkingSmsProvider;
  let config: { get: jest.Mock };

  beforeEach(async () => {
    config = { get: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AfricasTalkingSmsProvider,
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    service = moduleRef.get(AfricasTalkingSmsProvider);
  });

  it('silently no-ops when sms.atUsername / sms.atApiKey are blank', async () => {
    config.get.mockReturnValue(undefined);
    await expect(
      service.send('+233500000000', 'code'),
    ).resolves.toBeUndefined();
  });

  it('propagates a thrown error from the underlying SDK', async () => {
    config.get.mockImplementation((k: string) => {
      if (k === 'sms.atUsername') return 'sandbox';
      if (k === 'sms.atApiKey') return 'k';
      return undefined;
    });
    // Pre-seed the lazy `sms` instance so we don't load the real SDK.
    (service as unknown as { sms: { send: jest.Mock } }).sms = {
      send: jest.fn().mockRejectedValueOnce(new Error('AT 500')),
    };
    await expect(service.send('+233500000000', 'code')).rejects.toThrow(
      'AT 500',
    );
  });

  it('forwards the configured sender id when available', async () => {
    config.get.mockImplementation((k: string) => {
      if (k === 'sms.atUsername') return 'sandbox';
      if (k === 'sms.atApiKey') return 'k';
      if (k === 'sms.atSenderId') return 'Bondzi';
      return undefined;
    });
    const sendMock = jest.fn().mockResolvedValue(undefined);
    (service as unknown as { sms: { send: jest.Mock } }).sms = {
      send: sendMock,
    };
    await service.send('+233500000000', 'hi');
    expect(sendMock).toHaveBeenCalledWith({
      to: '+233500000000',
      message: 'hi',
      from: 'Bondzi',
    });
  });
});
