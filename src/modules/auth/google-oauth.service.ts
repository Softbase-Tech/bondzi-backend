import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';

export interface GoogleProfile {
  email: string;
  sub: string;
  name: string;
  picture?: string;
  emailVerified: boolean;
}

@Injectable()
export class GoogleOAuthService {
  private client: OAuth2Client;

  constructor(private readonly config: ConfigService) {
    this.client = new OAuth2Client(
      this.config.get<string>('GOOGLE_CLIENT_ID') ?? undefined,
    );
  }

  async verify(idToken: string): Promise<GoogleProfile> {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID');
    if (!clientId)
      throw new UnauthorizedException('Google sign-in not configured');
    const ticket = await this.client.verifyIdToken({
      idToken,
      audience: clientId,
    });
    const payload = ticket.getPayload();
    if (!payload?.email)
      throw new UnauthorizedException('Google token missing email');
    return {
      email: payload.email,
      sub: payload.sub,
      name: payload.name ?? payload.email,
      picture: payload.picture,
      emailVerified: payload.email_verified ?? false,
    };
  }
}
