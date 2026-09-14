import { registerAs } from '@nestjs/config';

/**
 * Reporting configuration.
 *
 * Recipients are per-report so the engineer can receive the daily system
 * section without also getting the monthly financials, and a co-founder
 * can be added without a deploy.
 *
 * There is deliberately no `REPORT_FROM`: sends go through the existing
 * MailService, which already owns `MAIL_FROM` / `MAIL_REPLY_TO` /
 * `RESEND_API_KEY`. Introducing a second from-address would mean two
 * domains to keep verified in Resend.
 */
export default registerAs('reports', () => ({
  /**
   * Kill switch, checked at the top of every cron handler. Lets a
   * mis-rendering report be stopped without a redeploy. Note
   * `MAIL_ENABLED=false` also dry-runs report mail for free, since sends
   * go through MailService — that is the softer switch (still computes and
   * logs), this one is the hard stop (computes nothing, sends nothing).
   */
  enabled: (process.env.REPORT_ENABLED ?? 'true').toLowerCase() === 'true',
  recipients: {
    daily: parseRecipients(process.env.REPORT_RECIPIENTS_DAILY ?? ''),
    weekly: parseRecipients(process.env.REPORT_RECIPIENTS_WEEKLY ?? ''),
    monthly: parseRecipients(process.env.REPORT_RECIPIENTS_MONTHLY ?? ''),
  },
  /**
   * Optional healthchecks.io ping URL, hit after a successful daily send.
   * A missing report is silence, and silence is indistinguishable from a
   * quiet day — this is what turns "no email" into an alert. Empty
   * disables it.
   */
  heartbeatUrl: process.env.REPORT_HEARTBEAT_URL ?? '',
}));

/**
 * Same convention as `mail.config.ts`: comma-split, `@`-filtered, and an
 * empty string explicitly means "nobody" rather than falling back to a
 * default. A typo'd address is dropped rather than sent to.
 */
function parseRecipients(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.includes('@'));
}
