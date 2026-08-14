import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

/**
 * Operational alerts to the platform admin inbox (AI budget, etc.).
 * Separate from user transactional mail — uses ADMIN_ALERT_EMAIL.
 */
@Injectable()
export class AdminAlertService {
  private readonly logger = new Logger(AdminAlertService.name);
  private resend: Resend | null = null;
  /** One or more valid admin inboxes — schema-validated at boot. */
  private alertTo: string[] = [];
  private from = '';
  private enabled = false;

  constructor(private readonly config: ConfigService) {
    this.enabled = this.config.get<boolean>('mail.enabled') ?? false;
    this.from = this.config.get<string>('mail.from') ?? '';
    // ADMIN_ALERT_EMAIL is a single email OR a comma-separated list
    // (Joi validates each address). Split + trim + drop empties so
    // trailing commas / extra whitespace don't create dead recipients.
    this.alertTo = (this.config.get<string>('app.adminAlertEmail') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const apiKey = this.config.get<string>('mail.apiKey') ?? '';
    if (this.enabled && apiKey) {
      this.resend = new Resend(apiKey);
    }
  }

  async send(subject: string, body: string): Promise<void> {
    if (this.alertTo.length === 0) {
      this.logger.warn(
        `[admin-alert] no ADMIN_ALERT_EMAIL — skipped: ${subject}`,
      );
      return;
    }
    if (!this.enabled || !this.resend) {
      this.logger.log(`[admin-alert.dry-run] ${subject}\n${body}`);
      return;
    }
    const { error } = await this.resend.emails.send({
      from: this.from,
      to: this.alertTo,
      subject: `[Bondzi] ${subject}`,
      text: body,
      html: `<pre style="font-family:monospace;font-size:13px;">${escapeHtml(body)}</pre>`,
    });
    if (error) {
      this.logger.error(
        `[admin-alert] Resend rejected: ${JSON.stringify(error)}`,
      );
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
