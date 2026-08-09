import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FirebaseAdminService } from './firebase-admin.service';

/**
 * FirebaseAdminService is built on graceful-degradation: missing credentials,
 * malformed PEMs, and SDK init failures must all leave the rest of the API
 * up. Push is never a hard dependency. Tests pin:
 *   - onModuleInit silently no-ops when any of the three FIREBASE_* envs
 *     are missing — `configured` stays false
 *   - onModuleInit silently no-ops when the private key isn't a PEM block
 *   - sendToTokens short-circuits (no FCM call) when the service is
 *     unconfigured, even with a non-empty token list
 *   - sendToTokens prunes only the FCM error codes we promise to prune
 *     (UNREGISTERED / INVALID_ARGUMENT / INVALID_REGISTRATION_TOKEN); other
 *     errors are logged but the token is NOT returned for deletion
 */

describe('FirebaseAdminService', () => {
  let service: FirebaseAdminService;
  let config: { get: jest.Mock };

  function makeConfig(overrides: Record<string, string | undefined> = {}) {
    return jest.fn((k: string) => overrides[k]);
  }

  beforeEach(async () => {
    config = { get: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        FirebaseAdminService,
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    service = moduleRef.get(FirebaseAdminService);
  });

  // ----------------------------- onModuleInit -----------------------------

  it('stays unconfigured when no FIREBASE_* envs are set', () => {
    config.get = makeConfig({});
    service.onModuleInit();
    expect(service.configured).toBe(false);
  });

  it('stays unconfigured when the private key lacks the PEM header', () => {
    config.get = makeConfig({
      'firebase.projectId': 'p',
      'firebase.clientEmail': 'a@b.com',
      'firebase.privateKey': 'not a pem block',
    });
    service.onModuleInit();
    expect(service.configured).toBe(false);
  });

  // ----------------------------- sendToTokens -----------------------------

  it('sendToTokens short-circuits when unconfigured (no FCM call, empty result)', async () => {
    const out = await service.sendToTokens(['tok-1'], {
      title: 't',
      body: 'b',
    });
    expect(out).toEqual({ successCount: 0, invalidTokens: [] });
  });

  it('sendToTokens short-circuits on an empty token list even when configured', async () => {
    const sendEachForMulticast = jest.fn();
    (service as unknown as { app: { messaging: () => unknown } }).app = {
      messaging: () => ({ sendEachForMulticast }),
    };
    const out = await service.sendToTokens([], { title: 't', body: 'b' });
    expect(out).toEqual({ successCount: 0, invalidTokens: [] });
    expect(sendEachForMulticast).not.toHaveBeenCalled();
  });

  it('sendToTokens prunes ONLY the documented "dead token" error codes', async () => {
    const sendEachForMulticast = jest.fn().mockResolvedValue({
      successCount: 1,
      responses: [
        { success: true },
        {
          success: false,
          error: { code: 'messaging/registration-token-not-registered' },
        },
        { success: false, error: { code: 'messaging/invalid-argument' } },
        { success: false, error: { code: 'messaging/internal-error' } },
      ],
    });
    (service as unknown as { app: { messaging: () => unknown } }).app = {
      messaging: () => ({ sendEachForMulticast }),
    };
    const out = await service.sendToTokens(
      ['live', 'dead1', 'dead2', 'transient'],
      { title: 't', body: 'b' },
    );
    // Two dead tokens are returned for pruning. The transient error is NOT
    // in the prune list — deleting it would lose deliveries on temporary FCM
    // outages.
    expect(out.invalidTokens.sort()).toEqual(['dead1', 'dead2']);
    expect(out.successCount).toBe(1);
  });
});
