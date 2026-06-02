import { BuiltMail, PasswordResetPayload } from '../mail.types';
import { brand, escapeText, renderLayout } from './_layout';

export function buildPasswordReset(
  payload: PasswordResetPayload,
  webUrl: string,
): BuiltMail {
  const greeting = payload.recipientName
    ? `Hi ${escapeText(payload.recipientName)},`
    : 'Hi there,';
  const requestedFromLine = payload.requestedFrom
    ? `<p style="margin:8px 0 0;color:${brand.muted};font-size:12px;">Request origin: ${escapeText(payload.requestedFrom)}</p>`
    : '';
  const body = `
    <p style="margin:0 0 14px;font-size:20px;font-weight:700;color:${brand.navy};">
      Reset your password
    </p>
    <p style="margin:0 0 14px;">${greeting}</p>
    <p style="margin:0 0 14px;">
      We received a request to reset your Bondzi password. Tap the button below
      to choose a new one. The link expires in
      <strong>${payload.expiresInMinutes} minutes</strong>.
    </p>
    <p style="margin:24px 0 0;color:${brand.muted};font-size:12px;">
      If you didn't request a password reset, you can safely ignore this email —
      your password won't change unless someone clicks the link above.
    </p>
    ${requestedFromLine}
  `;
  return {
    subject: 'Reset your Bondzi password',
    html: renderLayout({
      title: 'Reset password',
      preheader: 'Choose a new password — link expires soon.',
      body,
      cta: { label: 'Reset password', url: payload.resetUrl },
      webUrl,
    }),
    text:
      `${greeting}\n\nReset your Bondzi password by opening this link ` +
      `(expires in ${payload.expiresInMinutes} minutes):\n\n${payload.resetUrl}\n\n` +
      `If you didn't request this, ignore the email.`,
  };
}
