import {
  BuiltMail,
  PartnerAccountBannedPayload,
  PartnerAccountSuspendedPayload,
  PartnerAppealResolvedPayload,
  PartnerTermsUpdatedPayload,
} from '../mail.types';
import { brand, escapeText, formatDate, renderLayout } from './_layout';

// ---------------------------------------------------------------------------
// Suspended
// ---------------------------------------------------------------------------

export function buildPartnerAccountSuspended(
  payload: PartnerAccountSuspendedPayload,
  webUrl: string,
): BuiltMail {
  const { recipientName, partnerName, reason, appealsUrl, appealsRemaining } =
    payload;
  const displayName = escapeText(recipientName ?? partnerName ?? 'there');
  const body = `
    <p style="margin:0 0 12px;">Hi ${displayName},</p>
    <p style="margin:0 0 16px;">
      Your Bondzi partner account has been <strong>suspended</strong>
      pending review. New commissions will still accrue on your codes,
      but payouts are paused until the review clears.
    </p>
    <div style="margin:0 0 16px;padding:16px 20px;background:#FFF3E6;
                border:1px solid #F1C297;border-radius:10px;
                font-family:Helvetica,Arial,sans-serif;font-size:14px;
                color:${brand.text};">
      <p style="margin:0 0 6px;font-weight:700;">Reason</p>
      <p style="margin:0;">${escapeText(reason)}</p>
    </div>
    <p style="margin:0 0 16px;">
      You can open an appeal if you believe this is wrong. You have
      <strong>${appealsRemaining}</strong>
      appeal${appealsRemaining === 1 ? '' : 's'} remaining before a
      permanent ban.
    </p>`;
  const html = renderLayout({
    preheader: 'Your Bondzi partner account has been suspended.',
    title: 'Account suspended',
    body,
    cta: { label: 'Open an appeal', url: appealsUrl },
    webUrl,
  });
  return {
    subject: 'Bondzi partner account suspended',
    html,
    text: `Hi ${recipientName ?? partnerName ?? 'there'},\n\nYour Bondzi partner account has been suspended.\nReason: ${reason}\nYou have ${appealsRemaining} appeal(s) remaining. Appeal at: ${appealsUrl}`,
  };
}

// ---------------------------------------------------------------------------
// Banned
// ---------------------------------------------------------------------------

export function buildPartnerAccountBanned(
  payload: PartnerAccountBannedPayload,
  webUrl: string,
): BuiltMail {
  const { recipientName, partnerName, reason } = payload;
  const displayName = escapeText(recipientName ?? partnerName ?? 'there');
  const body = `
    <p style="margin:0 0 12px;">Hi ${displayName},</p>
    <p style="margin:0 0 16px;">
      Your Bondzi partner account has been <strong>permanently
      closed</strong>. Outstanding earnings are forfeit and no
      further payouts will be issued.
    </p>
    <div style="margin:0 0 16px;padding:16px 20px;background:#FEE2E2;
                border:1px solid #FCA5A5;border-radius:10px;
                font-family:Helvetica,Arial,sans-serif;font-size:14px;
                color:${brand.text};">
      <p style="margin:0 0 6px;font-weight:700;">Reason</p>
      <p style="margin:0;">${escapeText(reason)}</p>
    </div>
    <p style="margin:0 0 16px;">
      This decision is final. If you believe there's been a serious
      mistake, reply to this email and our team will look into it.
      Your Bondzi student account is unaffected.
    </p>`;
  const html = renderLayout({
    preheader: 'Your Bondzi partner account has been closed.',
    title: 'Account closed',
    body,
    webUrl,
  });
  return {
    subject: 'Bondzi partner account closed',
    html,
    text: `Hi ${recipientName ?? partnerName ?? 'there'},\n\nYour Bondzi partner account has been permanently closed. Reason: ${reason}. Outstanding earnings are forfeit.`,
  };
}

// ---------------------------------------------------------------------------
// Terms updated
// ---------------------------------------------------------------------------

export function buildPartnerTermsUpdated(
  payload: PartnerTermsUpdatedPayload,
  webUrl: string,
): BuiltMail {
  const {
    recipientName,
    partnerName,
    newVersion,
    changeSummary,
    effectiveFrom,
    termsUrl,
  } = payload;
  const displayName = escapeText(recipientName ?? partnerName ?? 'there');
  const body = `
    <p style="margin:0 0 12px;">Hi ${displayName},</p>
    <p style="margin:0 0 16px;">
      The Bondzi partner agreement has been updated. The new terms
      (<strong>version ${newVersion}</strong>) take effect on
      ${escapeText(formatDate(effectiveFrom))}.
    </p>
    <div style="margin:0 0 16px;padding:16px 20px;background:#FFFBEA;
                border:1px solid #F1D57C;border-radius:10px;
                font-family:Helvetica,Arial,sans-serif;font-size:14px;
                color:${brand.text};">
      <p style="margin:0 0 6px;font-weight:700;">What changed</p>
      <p style="margin:0;white-space:pre-wrap;">${escapeText(changeSummary)}</p>
    </div>
    <p style="margin:0 0 16px;">
      Existing commissions stay pinned to the version they were
      earned under — this update only applies to earnings from
      ${escapeText(formatDate(effectiveFrom))} onwards.
    </p>`;
  const html = renderLayout({
    preheader: `Bondzi partner terms updated — v${newVersion}.`,
    title: 'Terms updated',
    body,
    cta: { label: 'Read the new terms', url: termsUrl },
    webUrl,
  });
  return {
    subject: `Bondzi partner terms updated (v${newVersion})`,
    html,
    text: `Hi ${recipientName ?? partnerName ?? 'there'},\n\nBondzi partner terms updated to v${newVersion}, effective ${formatDate(effectiveFrom)}.\nWhat changed:\n${changeSummary}\n\nRead the terms: ${termsUrl}`,
  };
}

// ---------------------------------------------------------------------------
// Appeal resolved
// ---------------------------------------------------------------------------

export function buildPartnerAppealResolved(
  payload: PartnerAppealResolvedPayload,
  webUrl: string,
): BuiltMail {
  const {
    recipientName,
    partnerName,
    appealNumber,
    decision,
    resolutionNote,
    triggersBan,
    appealsRemaining,
    appealsUrl,
  } = payload;
  const displayName = escapeText(recipientName ?? partnerName ?? 'there');
  const noteHtml = resolutionNote
    ? `<div style="margin:0 0 16px;padding:16px 20px;background:#F8FAFC;
                  border:1px solid #E5E7EB;border-radius:10px;
                  font-family:Helvetica,Arial,sans-serif;font-size:14px;
                  color:${brand.text};">
         <p style="margin:0 0 6px;font-weight:700;">Note from the review team</p>
         <p style="margin:0;white-space:pre-wrap;">${escapeText(resolutionNote)}</p>
       </div>`
    : '';

  let leadCopy: string;
  let subject: string;
  let cta: { label: string; url: string } | undefined;
  if (decision === 'upheld') {
    leadCopy = `
      <p style="margin:0 0 16px;">
        Good news — your appeal has been <strong>upheld</strong>.
        Your partner account is fully reinstated and any commissions
        that were paused are back on the payout queue.
      </p>`;
    subject = `Appeal #${appealNumber} — upheld`;
    cta = { label: 'Go to partner dashboard', url: appealsUrl };
  } else if (triggersBan) {
    leadCopy = `
      <p style="margin:0 0 16px;">
        Your appeal has been <strong>denied</strong>. Because this
        was your third denied appeal, your Bondzi partner account
        is now <strong>permanently closed</strong>. Outstanding
        earnings are forfeit.
      </p>`;
    subject = `Appeal #${appealNumber} — denied (account closed)`;
  } else {
    leadCopy = `
      <p style="margin:0 0 16px;">
        Your appeal has been <strong>denied</strong>. Your account
        remains suspended. You have
        <strong>${appealsRemaining}</strong>
        appeal${appealsRemaining === 1 ? '' : 's'} remaining before
        a permanent ban.
      </p>`;
    subject = `Appeal #${appealNumber} — denied`;
    cta = { label: 'Open another appeal', url: appealsUrl };
  }
  const body = `
    <p style="margin:0 0 12px;">Hi ${displayName},</p>
    ${leadCopy}
    ${noteHtml}`;
  const html = renderLayout({
    preheader: subject,
    title:
      decision === 'upheld'
        ? 'Appeal upheld'
        : triggersBan
          ? 'Account closed'
          : 'Appeal denied',
    body,
    cta,
    webUrl,
  });
  return {
    subject: `Bondzi partner ${subject}`,
    html,
    text: `Hi ${recipientName ?? partnerName ?? 'there'},\n\nAppeal #${appealNumber} was ${decision}.${resolutionNote ? `\nNote: ${resolutionNote}` : ''}${triggersBan ? '\nYour account is now permanently closed.' : ''}`,
  };
}
