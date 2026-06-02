import { BuiltMail, PaymentSuccessPayload } from '../mail.types';
import {
  brand,
  escapeText,
  formatDate,
  formatMoney,
  renderLayout,
} from './_layout';
import { computeVatInclusive } from '../pdf/vat.util';
import { generateReceiptPdf } from '../pdf/receipt.pdf';

/**
 * Receipt email for both Plus (one-time) and Pro (recurring) charges.
 *
 * The same template handles both — the `validUntil` field carries either
 * "Lifetime" (Plus) or the next renewal date (Pro). The HTML body shows
 * the VAT-inclusive breakdown inline, AND a full PDF receipt is attached
 * for the user's records.
 */
export async function buildPaymentSuccess(
  payload: PaymentSuccessPayload,
  webUrl: string,
  recipientEmail: string,
): Promise<BuiltMail> {
  const greeting = payload.recipientName
    ? `Hi ${escapeText(payload.recipientName)},`
    : 'Hi there,';
  const vat = computeVatInclusive(payload.amountDisplay, payload.vatRatePct);
  const body = `
    <p style="margin:0 0 14px;font-size:20px;font-weight:700;color:${brand.navy};">
      Payment received — thank you!
    </p>
    <p style="margin:0 0 14px;">${greeting}</p>
    <p style="margin:0 0 14px;">
      Your payment for <strong>${escapeText(payload.planName)}</strong> went through.
      Receipt is attached as a PDF for your records.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="margin:18px 0;border:1px solid #ECECF0;border-radius:10px;
                  font-family:Helvetica,Arial,sans-serif;font-size:14px;">
      <tr><td style="padding:10px 14px;color:${brand.muted};">Account</td>
          <td style="padding:10px 14px;text-align:right;">${escapeText(payload.account)} · ${escapeText(payload.level)}</td></tr>
      <tr><td style="padding:10px 14px;color:${brand.muted};border-top:1px solid #ECECF0;">Reference</td>
          <td style="padding:10px 14px;text-align:right;border-top:1px solid #ECECF0;
                     font-family:Menlo,monospace;font-size:12px;">${escapeText(payload.reference)}</td></tr>
      <tr><td style="padding:10px 14px;color:${brand.muted};border-top:1px solid #ECECF0;">Paid on</td>
          <td style="padding:10px 14px;text-align:right;border-top:1px solid #ECECF0;">${escapeText(formatDate(payload.paidAt))}</td></tr>
      <tr><td style="padding:10px 14px;color:${brand.muted};border-top:1px solid #ECECF0;">Valid until</td>
          <td style="padding:10px 14px;text-align:right;border-top:1px solid #ECECF0;">${escapeText(payload.validUntil)}</td></tr>
      <tr><td style="padding:10px 14px;color:${brand.muted};border-top:1px solid #ECECF0;">Subtotal (net)</td>
          <td style="padding:10px 14px;text-align:right;border-top:1px solid #ECECF0;">${escapeText(formatMoney(vat.net, payload.currency))}</td></tr>
      <tr><td style="padding:10px 14px;color:${brand.muted};">VAT @ ${vat.ratePct.toFixed(2)}%</td>
          <td style="padding:10px 14px;text-align:right;">${escapeText(formatMoney(vat.vat, payload.currency))}</td></tr>
      <tr><td style="padding:12px 14px;font-weight:700;color:${brand.navy};
                     border-top:1px solid #ECECF0;">Total paid</td>
          <td style="padding:12px 14px;text-align:right;font-weight:700;
                     color:${brand.orange};border-top:1px solid #ECECF0;">
              ${escapeText(formatMoney(vat.gross, payload.currency))}</td></tr>
    </table>

    <p style="margin:0 0 14px;">
      You can manage your subscription or view past receipts any time from
      <strong>Settings → Subscription</strong> in the app.
    </p>
    <p style="margin:0 0 6px;">— The Bondzi team</p>
  `;
  const html = renderLayout({
    title: 'Payment receipt',
    preheader: `Receipt for ${payload.planName} — ${formatMoney(vat.gross, payload.currency)}`,
    body,
    cta: { label: 'Open Bondzi', url: webUrl },
    webUrl,
  });

  const pdf = await generateReceiptPdf({
    recipientName: payload.recipientName ?? 'Bondzi student',
    recipientEmail,
    planName: payload.planName,
    account: payload.account,
    level: payload.level,
    amountDisplay: payload.amountDisplay,
    currency: payload.currency,
    vatRatePct: payload.vatRatePct,
    paidAt: payload.paidAt,
    reference: payload.reference,
    validUntil: payload.validUntil,
  });

  return {
    subject: `Receipt — ${payload.planName} (${formatMoney(vat.gross, payload.currency)})`,
    html,
    text:
      `${greeting}\n\nYour payment for ${payload.planName} (${formatMoney(vat.gross, payload.currency)}) ` +
      `was received on ${formatDate(payload.paidAt)}.\n\n` +
      `Reference: ${payload.reference}\nValid until: ${payload.validUntil}\n\n` +
      `Net: ${formatMoney(vat.net, payload.currency)}\n` +
      `VAT (${vat.ratePct.toFixed(2)}%): ${formatMoney(vat.vat, payload.currency)}\n` +
      `Total: ${formatMoney(vat.gross, payload.currency)}\n\n` +
      `A PDF receipt is attached.`,
    attachments: [
      {
        filename: `bondzi-receipt-${payload.reference}.pdf`,
        content: pdf,
        contentType: 'application/pdf',
      },
    ],
  };
}
