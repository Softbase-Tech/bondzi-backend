import { BuiltMail, RefundConfirmationPayload } from '../mail.types';
import {
  brand,
  escapeText,
  formatDate,
  formatMoney,
  renderLayout,
} from './_layout';
import { generateReceiptPdf } from '../pdf/receipt.pdf';

/**
 * Confirms a Paystack refund has been processed. The user's premium
 * access for the affected level has already been revoked at the time
 * this email goes out (webhook handler flips status to REFUNDED before
 * dispatching the mail event).
 *
 * Attaches a PDF refund receipt re-using the same generator as
 * payment-success — the document carries a "Refunded on" timestamp and
 * a negative-amount line so the user has a single authoritative record.
 */
export async function buildRefundConfirmation(
  payload: RefundConfirmationPayload,
  webUrl: string,
  recipientEmail: string,
): Promise<BuiltMail> {
  const greeting = payload.recipientName
    ? `Hi ${escapeText(payload.recipientName)},`
    : 'Hi there,';
  const body = `
    <p style="margin:0 0 14px;font-size:20px;font-weight:700;color:${brand.navy};">
      Refund processed
    </p>
    <p style="margin:0 0 14px;">${greeting}</p>
    <p style="margin:0 0 14px;">
      We've refunded <strong>${escapeText(formatMoney(payload.amountDisplay, payload.currency))}</strong>
      to your original payment method for <strong>${escapeText(payload.planName)}</strong>.
      Paystack typically settles refunds within 7 working days — please contact
      your bank if it hasn't appeared by then.
    </p>
    <p style="margin:0 0 14px;">
      Your premium access for <strong>${escapeText(payload.level)}</strong> has been
      removed. The rest of your Bondzi account stays exactly as it was.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="margin:18px 0;border:1px solid #ECECF0;border-radius:10px;
                  font-family:Helvetica,Arial,sans-serif;font-size:14px;">
      <tr><td style="padding:10px 14px;color:${brand.muted};">Refunded on</td>
          <td style="padding:10px 14px;text-align:right;">${escapeText(formatDate(payload.refundedAt))}</td></tr>
      <tr><td style="padding:10px 14px;color:${brand.muted};border-top:1px solid #ECECF0;">Reference</td>
          <td style="padding:10px 14px;text-align:right;border-top:1px solid #ECECF0;
                     font-family:Menlo,monospace;font-size:12px;">${escapeText(payload.reference)}</td></tr>
      <tr><td style="padding:12px 14px;font-weight:700;color:${brand.navy};
                     border-top:1px solid #ECECF0;">Refunded amount</td>
          <td style="padding:12px 14px;text-align:right;font-weight:700;
                     color:${brand.orange};border-top:1px solid #ECECF0;">
              ${escapeText(formatMoney(payload.amountDisplay, payload.currency))}</td></tr>
    </table>

    <p style="margin:0 0 14px;">
      If this refund wasn't expected, reply to this email and we'll look into it.
    </p>
    <p style="margin:0 0 6px;">— The Bondzi team</p>
  `;
  const html = renderLayout({
    title: 'Refund processed',
    preheader: `Refund processed: ${formatMoney(payload.amountDisplay, payload.currency)}`,
    body,
    cta: { label: 'Open Bondzi', url: webUrl },
    webUrl,
  });

  // Re-use the receipt generator with a refund marker in the validUntil
  // field. The PDF reads as a record of money OUT, not money IN.
  const pdf = await generateReceiptPdf({
    recipientName: payload.recipientName ?? 'Bondzi student',
    recipientEmail,
    planName: `Refund — ${payload.planName}`,
    account: 'Refund',
    level: payload.level,
    amountDisplay: payload.amountDisplay,
    currency: payload.currency,
    vatRatePct: 0, // refunds reverse the full gross — VAT line collapses
    paidAt: payload.refundedAt,
    reference: payload.reference,
    validUntil: 'N/A (refunded)',
  });

  return {
    subject: `Refund processed — ${formatMoney(payload.amountDisplay, payload.currency)}`,
    html,
    text:
      `${greeting}\n\nWe've refunded ${formatMoney(payload.amountDisplay, payload.currency)} ` +
      `to your original payment method for ${payload.planName}. ` +
      `Refunds typically settle within 7 working days.\n\n` +
      `Your premium access for ${payload.level} has been removed.\n\n` +
      `Reference: ${payload.reference}\nRefunded on: ${formatDate(payload.refundedAt)}\n\n` +
      `A PDF refund receipt is attached. If this wasn't expected, reply to this email.`,
    attachments: [
      {
        filename: `bondzi-refund-${payload.reference}.pdf`,
        content: pdf,
        contentType: 'application/pdf',
      },
    ],
  };
}
