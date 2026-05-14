import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { GoogleOAuthService } from './google-oauth.service';

/**
 * GoogleOAuthService wraps google-auth-library. Tests cover:
 *   - the "not configured" path (no GOOGLE_CLIENT_ID) → Unauthorized
 *   - a verified ticket → normalised profile
 *   - a ticket without an email → Unauthorized
 *   - emailVerified defaulting to false when the claim is absent
 */

describe('GoogleOAuthService', () => {
  let service: GoogleOAuthService;
  let config: { get: jest.Mock };

  beforeEach(async () => {
    config = {
      get: jest.fn((k: string) =>
        k === 'GOOGLE_CLIENT_ID' ? 'cid' : undefined,
      ),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        GoogleOAuthService,
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    service = moduleRef.get(GoogleOAuthService);
  });

  function stubTicket(payload: Record<string, unknown> | undefined) {
    // Reach into the private client and stub verifyIdToken.
    const client = (
      service as unknown as { client: { verifyIdToken: jest.Mock } }
    ).client;
    client.verifyIdToken = jest.fn().mockResolvedValue({
      getPayload: () => payload,
    });
  }

  it('rejects when GOOGLE_CLIENT_ID is unset (not configured)', async () => {
    config.get.mockReturnValueOnce(undefined);
    await expect(service.verify('tok')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('normalises a verified ticket into a GoogleProfile', async () => {
    stubTicket({
      email: 'a@b.com',
      sub: 'g-123',
      name: 'Ada',
      picture: 'pic',
      email_verified: true,
    });
    expect(await service.verify('tok')).toEqual({
      email: 'a@b.com',
      sub: 'g-123',
      name: 'Ada',
      picture: 'pic',
      emailVerified: true,
    });
  });

  it('rejects when the ticket payload is missing an email', async () => {
    stubTicket({ sub: 'g-123' });
    await expect(service.verify('tok')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('defaults emailVerified to false when email_verified is absent', async () => {
    stubTicket({ email: 'a@b.com', sub: 'g-123' });
    const out = await service.verify('tok');
    expect(out.emailVerified).toBe(false);
    expect(out.name).toBe('a@b.com'); // falls back to email when name missing
  });
});
