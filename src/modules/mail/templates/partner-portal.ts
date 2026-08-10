import {
  BuiltMail,
  PartnerAgreementPayload,
  PartnerApprovedPayload,
  PartnerPayoutPaidPayload,
} from '../mail.types';
import { brand, escapeText, formatDate, renderLayout } from './_layout';

// ---------------------------------------------------------------------------
// Partner agreement (sent on register)
// ---------------------------------------------------------------------------

export function buildPartnerAgreement(
  payload: PartnerAgreementPayload,
  webUrl: string,
): BuiltMail {
  const {
    recipientName,
    partnerName,
    defaultCode,
    termsVersion,
    termsBodyMd,
    plusWassceGhs,
    plusNovdecGhs,
    plusBeceGhs,
    signupBatchAmountGhs,
    signupBatchSize,
    signupMinCompletedAnswers,
    answersBonusAmountGhs,
    answersBonusThreshold,
    attributionWindowDays,
  } = payload;

  const displayName = escapeText(recipientName ?? partnerName ?? 'there');
  const codeHtml = renderCodeBox(defaultCode);
  const summary = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="border:1px solid #ECECF0;border-radius:10px;margin-top:24px;">
      <tr>
        <td style="padding:20px 24px;font-family:Helvetica,Arial,sans-serif;font-size:14px;
                   color:${brand.text};">
          <p style="margin:0 0 8px;font-weight:700;color:${brand.navy};">
            Your rates (v${termsVersion})
          </p>
          <ul style="margin:8px 0 0;padding-left:20px;line-height:1.7;">
            <li>Plus WASSCE — GHS ${escapeText(plusWassceGhs)}</li>
            <li>Plus NOVDEC — GHS ${escapeText(plusNovdecGhs)}</li>
            <li>Plus BECE — GHS ${escapeText(plusBeceGhs)}</li>
            <li>Signup batch — GHS ${escapeText(signupBatchAmountGhs)}
                per ${signupBatchSize} referred users who answer at least
                ${signupMinCompletedAnswers} questions.</li>
            <li>Answers bonus — GHS ${escapeText(answersBonusAmountGhs)}
                once a paid-Plus referred user crosses
                ${answersBonusThreshold} answers.</li>
            <li>Attribution window — ${attributionWindowDays} days from
                signup.</li>
          </ul>
        </td>
      </tr>
    </table>`;

  const termsHtml = `
    <div style="margin-top:24px;padding:20px 24px;border:1px solid #ECECF0;
                border-radius:10px;font-family:Helvetica,Arial,sans-serif;
                font-size:13px;color:${brand.muted};line-height:1.55;
                white-space:pre-wrap;">${escapeText(termsBodyMd)}</div>`;

  const body = `
    <p style="margin:0 0 12px;">Hi ${displayName},</p>
    <p style="margin:0 0 16px;">
      Welcome to the Bondzi partner programme. Your account is
      <strong>pending review</strong> — we'll approve it within a
      couple of business days. Your referral code is live and
      earning attribution the moment students sign up with it.
    </p>
    ${codeHtml}
    ${summary}
    <p style="margin:24px 0 8px;font-weight:700;color:${brand.navy};">
      Terms of the agreement
    </p>
    ${termsHtml}
    <p style="margin:24px 0 0;">
      A copy of these terms sits at the bottom of this email for your
      records — keep it. Questions? Reply to this email.
    </p>`;

  const html = renderLayout({
    preheader: `Welcome to the Bondzi partner programme — terms v${termsVersion}`,
    title: 'Partner agreement',
    body,
    webUrl,
  });

  return {
    subject: `Welcome to the Bondzi partner programme (v${termsVersion} terms)`,
    html,
    text: `Hi ${recipientName ?? partnerName ?? 'there'},\n\nYour Bondzi partner account is pending review. Default referral code: ${defaultCode}.\n\nTerms version ${termsVersion}. See the full email for the rate card and terms document.`,
  };
}

// ---------------------------------------------------------------------------
// Partner approved (sent when admin flips pending → active)
// ---------------------------------------------------------------------------

export function buildPartnerApproved(
  payload: PartnerApprovedPayload,
  webUrl: string,
): BuiltMail {
  const { recipientName, partnerName, defaultCode, portalUrl } = payload;
  const displayName = escapeText(recipientName ?? partnerName ?? 'there');
  const codeHtml = renderCodeBox(defaultCode);
  const body = `
    <p style="margin:0 0 12px;">Hi ${displayName},</p>
    <p style="margin:0 0 12px;">
      Your Bondzi partner account is <strong>approved and live</strong>.
      Every commission you've already earned while pending review is
      now payable — sign in to your dashboard to see the current
      total.
    </p>
    ${codeHtml}
    <p style="margin:20px 0 0;color:${brand.muted};">
      Payouts run weekly. We'll email you an invoice + MoMo transfer
      confirmation whenever we pay out — no action required on your side.
    </p>`;
  const html = renderLayout({
    preheader: `You're approved — Bondzi partner code ${defaultCode} is live.`,
    title: 'Partner approved',
    body,
    cta: { label: 'Open partner dashboard', url: portalUrl },
    webUrl,
  });
  return {
    subject: 'Your Bondzi partner account is approved',
    html,
    text: `Hi ${recipientName ?? partnerName ?? 'there'},\n\nYour Bondzi partner account is approved. Default code: ${defaultCode}. Dashboard: ${portalUrl}`,
  };
}

// ---------------------------------------------------------------------------
// Partner payout paid (sent when admin marks a payout paid; carries PDF)
// ---------------------------------------------------------------------------

export function buildPartnerPayoutPaid(
  payload: PartnerPayoutPaidPayload,
  webUrl: string,
  invoicePdf?: Buffer,
): BuiltMail {
  const {
    recipientName,
    partnerName,
    amountDisplay,
    currency,
    weekOf,
    invoiceNumber,
    momoProvider,
    momoNumber,
    momoReference,
    commissionCount,
    paidAt,
  } = payload;

  const displayName = escapeText(recipientName ?? partnerName ?? 'there');
  const paidLabel = escapeText(`${currency} ${amountDisplay}`);
  const body = `
    <p style="margin:0 0 12px;">Hi ${displayName},</p>
    <p style="margin:0 0 16px;">
      We just paid out <strong style="color:${brand.orange};">${paidLabel}</strong>
      to your MoMo. That covers <strong>${commissionCount}</strong>
      commissions earned up to the week of
      ${escapeText(formatDateString(weekOf))}.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="border:1px solid #ECECF0;border-radius:10px;margin:12px 0 0;">
      <tr>
        <td style="padding:20px 24px;font-family:Helvetica,Arial,sans-serif;
                   font-size:14px;color:${brand.text};line-height:1.7;">
          <div><strong>Invoice</strong> — ${escapeText(invoiceNumber)}</div>
          <div><strong>Paid at</strong> — ${escapeText(formatDate(paidAt))}</div>
          <div><strong>MoMo</strong> — ${escapeText(momoProvider)} · ${escapeText(momoNumber)}</div>
          <div><strong>MoMo reference</strong> — ${escapeText(momoReference)}</div>
        </td>
      </tr>
    </table>
    <p style="margin:20px 0 0;color:${brand.muted};">
      The invoice PDF is attached for your records.
    </p>`;
  const html = renderLayout({
    preheader: `Bondzi payout ${paidLabel} — invoice ${invoiceNumber}`,
    title: 'Payout paid',
    body,
    webUrl,
  });

  const built: BuiltMail = {
    subject: `Bondzi partner payout — ${paidLabel} paid`,
    html,
    text: `Hi ${recipientName ?? partnerName ?? 'there'},\n\nWe paid you ${currency} ${amountDisplay} for ${commissionCount} commissions.\nInvoice: ${invoiceNumber}\nMoMo reference: ${momoReference}\n`,
  };

  if (invoicePdf) {
    built.attachments = [
      {
        filename: `bondzi-partner-invoice-${invoiceNumber}.pdf`,
        content: invoicePdf,
        contentType: 'application/pdf',
      },
    ];
  }
  return built;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderCodeBox(code: string): string {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="margin:20px 0 0;">
      <tr>
        <td align="center" style="padding:16px 20px;background:#F8FAFC;
                                  border:1px dashed #94A3B8;border-radius:10px;
                                  font-family:'Courier New',monospace;font-size:22px;
                                  font-weight:700;letter-spacing:3px;color:${brand.navy};">
          ${escapeText(code)}
        </td>
      </tr>
    </table>`;
}

function formatDateString(iso: string): string {
  // Payload dates arrive as ISO strings for week_of; render nicely.
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return formatDate(d);
  } catch {
    return iso;
  }
}
