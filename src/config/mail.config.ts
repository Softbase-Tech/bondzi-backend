import { registerAs } from '@nestjs/config';

/**
 * Resend transactional-email configuration.
 *
 * The previous nodemailer/SMTP shape (host/port/user/password) is gone:
 * we now send via the Resend HTTP API, which handles bounces, retries,
 * domain verification and analytics centrally.
 *
 * `enabled` lets dev/test environments short-circuit the Resend API call
 * entirely — the MailService logs "would send" and returns success
 * without contacting the network. Production must leave it `true` and
 * set `RESEND_API_KEY`.
 *
 * `replyTo` is the human inbox the user lands in when they hit Reply on
 * any transactional email — set to support@ so receipts, refund
 * confirmations and password-reset emails all route to the support
 * queue rather than the noreply alias.
 */
export default registerAs('mail', () => ({
  enabled: (process.env.MAIL_ENABLED ?? 'true').toLowerCase() === 'true',
  apiKey: process.env.RESEND_API_KEY ?? '',
  from: process.env.MAIL_FROM ?? 'Bondzi <noreply@bondzi.app>',
  replyTo: process.env.MAIL_REPLY_TO ?? 'support@bondzi.app',
  /**
   * Brand-side URL prefix used inside template links (CTA buttons,
   * unsubscribe footer, etc.). For dev this points at localhost; for
   * production it's the marketing site / deep-link host.
   */
  webUrl:
    process.env.MAIL_WEB_URL ?? process.env.APP_URL ?? 'https://bondzi.app',
}));
