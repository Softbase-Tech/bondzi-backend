import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import AfricasTalking from 'africastalking';

/**
 * Thin wrapper around Africa's Talking for SMS OTP delivery. The SDK is loaded
 * lazily so tests and dev (where AT_API_KEY is blank) don't crash at startup.
 *
 * Reliability — the previous shape had:
 *   - no timeout: a flaky AT outage blocks `/auth/login` and `/auth/otp/send`
 *     for the SDK's default socket timeout (~30-60s).
 *   - no retry: a single transient 5xx from AT failed the whole OTP send.
 *   - no circuit breaker: every request keeps hammering AT during an outage.
 *
 * We now race the call against a 6s timeout and retry once with backoff;
 * any failure beyond that surfaces to the caller (so the login screen can
 * show the right error).
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

const SEND_TIMEOUT_MS = 6_000;
const SEND_MAX_ATTEMPTS = 2;
const SEND_RETRY_DELAY_MS = 750;

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

    let lastErr: unknown;
    for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.sendWithTimeout(sms, { to, message, from });
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < SEND_MAX_ATTEMPTS) {
          this.logger.warn(
            `SMS send attempt ${attempt} failed for ${to}: ${(err as Error).message}`,
          );
          await new Promise((r) => setTimeout(r, SEND_RETRY_DELAY_MS));
          continue;
        }
        this.logger.error(
          `SMS send failed for ${to} after ${attempt} attempt(s): ${(err as Error).message}`,
        );
        throw err;
      }
    }
    // Unreachable — the loop either returns on success or throws on the
    // final attempt. Keep the throw for the TS exhaustiveness checker;
    // wrap as an Error so it satisfies the `only-throw-error` lint rule.
    throw lastErr instanceof Error ? lastErr : new Error('SMS send failed');
  }

  /**
   * Race the SDK call against a manual timeout. The AT SDK uses axios
   * internally and respects axios's default 0-timeout (none), so without
   * this wrapper an unreachable AT host hangs the request indefinitely.
   */
  private async sendWithTimeout(
    sms: AtSms,
    payload: { to: string; message: string; from?: string },
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const send = sms.send(payload);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`SMS send timed out after ${SEND_TIMEOUT_MS}ms`)),
        SEND_TIMEOUT_MS,
      );
      timer.unref?.();
    });
    try {
      await Promise.race([send, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
