import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import AfricasTalking from 'africastalking';

/**
 * Thin wrapper around Africa's Talking for SMS OTP delivery. The SDK is loaded
 * lazily so tests and dev (where AT_API_KEY is blank) don't crash at startup.
 *
 * Swap in WhatsApp Business API in Phase 2 — the provider interface is
 * intentionally minimal.
 */
export interface SmsProvider {
  send(to: string, message: string): Promise<void>;
}

interface AtSms {
  send(payload: {
    to: string | string[];
    message: string;
    from?: string;
  }): Promise<unknown>;
}

@Injectable()
export class AfricasTalkingSmsProvider implements SmsProvider {
  private readonly logger = new Logger(AfricasTalkingSmsProvider.name);
  private sms: AtSms | null = null;

  constructor(private readonly config: ConfigService) {}

  private getSms(): AtSms | null {
    if (this.sms) return this.sms;
    const username = this.config.get<string>('sms.atUsername');
    const apiKey = this.config.get<string>('sms.atApiKey');
    if (!username || !apiKey) return null;
    const client = AfricasTalking({ username, apiKey });
    this.sms = client.SMS;
    return this.sms;
  }

  async send(to: string, message: string): Promise<void> {
    const sms = this.getSms();
    if (!sms) {
      this.logger.warn(
        `SMS provider not configured; would send to ${to}: ${message}`,
      );
      return;
    }
    const from = this.config.get<string>('sms.atSenderId') || undefined;
    try {
      await sms.send({ to, message, from });
    } catch (err) {
      this.logger.error(`SMS send failed for ${to}: ${(err as Error).message}`);
      throw err;
    }
  }
}
