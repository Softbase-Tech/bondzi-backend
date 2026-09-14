import { OpsReportPayload, BuiltMail } from '../mail.types';

/**
 * Operational report (daily / weekly / monthly) — a deliberate pass-through.
 *
 * Every other template in this directory owns its own markup: it receives
 * structured data and decides how to present it. This one does not, and
 * that asymmetry is intentional.
 *
 * A report's layout *is* its content. The renderers in
 * `modules/reports/render/` build the subject line, the HTML and the plain
 * text together from the same metric set, because the information
 * hierarchy has to be decided once across all three — a sparkline, a
 * status badge and a delta arrow are not things a generic mail template
 * can reconstruct from a payload. Splitting that across a renderer and a
 * template would mean two places to change every time a metric moves, and
 * would make the plain-text part drift from the HTML.
 *
 * So reports render themselves and ride this event purely to inherit what
 * `MailService` provides: the Resend wiring, `MAIL_ENABLED` dry-run, the
 * `email_sends` audit rows, bounce webhooks, and — the one that matters —
 * the `dedup_key` claim that makes sending the same report period twice
 * physically impossible.
 *
 * No brand layout is applied for the same reason: `renderLayout` adds a
 * marketing header, footer and unsubscribe link. These go to two or three
 * internal inboxes, never to a student, and an unsubscribe link on an
 * operational alert is an invitation to silence the thing that tells you
 * the system is broken.
 */
export function buildOpsReport(payload: OpsReportPayload): BuiltMail {
  return {
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
  };
}
