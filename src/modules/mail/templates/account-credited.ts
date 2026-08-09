import { AccountCreditedPayload, BuiltMail } from '../mail.types';
import { brand, escapeText, renderLayout } from './_layout';

/**
 * "Your account was credited" email — fires when an admin manually
 * grants a user Plus or Pro entitlement (e.g. partnership comp, comp
 * for an outage, school sponsorship). Distinct from PAYMENT_SUCCESS:
 * there's no transaction, no receipt, no Paystack reference — the
 * copy explains the gift + how long it lasts.
 */
export function buildAccountCredited(
  payload: AccountCreditedPayload,
  webUrl: string,
): BuiltMail {
  const greeting = payload.recipientName
    ? `Hi ${escapeText(payload.recipientName)},`
    : 'Hi there,';
  const noteBlock = payload.adminNote
    ? `<div style="
        margin:14px 0;
        padding:12px 14px;
        background:#FFF7F4;
        border-left:3px solid ${brand.orange};
        border-radius:6px;
        font-size:13px;
        color:${brand.text};
      ">
        <strong style="color:${brand.navy};">Note from the team:</strong><br>
        ${escapeText(payload.adminNote)}
      </div>`
    : '';
  const body = `
    <p style="margin:0 0 14px;font-size:20px;font-weight:700;color:${brand.navy};">
      You've been credited with ${escapeText(payload.account)} on ${escapeText(payload.level)}!
    </p>
    <p style="margin:0 0 14px;">${greeting}</p>
    <p style="margin:0 0 14px;">
      Our team has granted you
      <strong>${escapeText(payload.account)}</strong>
      access on <strong>${escapeText(payload.level)}</strong>.
      Open the app — your premium features are unlocked.
    </p>
    <p style="margin:0 0 14px;color:${brand.muted};font-size:13px;">
      Valid until: <strong style="color:${brand.navy};">${escapeText(payload.validUntil)}</strong>
    </p>
    ${noteBlock}
    <p style="margin:24px 0 0;color:${brand.muted};font-size:12px;">
      Questions about this credit? Reply to this email and we'll
      sort it out.
    </p>
  `;
  return {
    subject: `${payload.account} unlocked on ${payload.level}`,
    html: renderLayout({
      title: 'Account credited',
      preheader: `${payload.account} on ${payload.level} is active — valid until ${payload.validUntil}.`,
      body,
      cta: { label: 'Open Bondzi', url: webUrl },
      webUrl,
    }),
    text:
      `${greeting}\n\n` +
      `You've been granted ${payload.account} on ${payload.level} by the Bondzi team. ` +
      `Valid until: ${payload.validUntil}.\n\n` +
      (payload.adminNote ? `Note: ${payload.adminNote}\n\n` : '') +
      `Open the app to start using your premium features.`,
  };
}
