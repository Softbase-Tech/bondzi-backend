import { BuiltMail, EmailVerificationPayload } from '../mail.types';
import { brand, escapeText, renderLayout } from './_layout';

export function buildEmailVerification(
  payload: EmailVerificationPayload,
  webUrl: string,
): BuiltMail {
  const greeting = payload.recipientName
    ? `Hi ${escapeText(payload.recipientName)},`
    : 'Hi there,';
  const body = `
    <p style="margin:0 0 14px;font-size:20px;font-weight:700;color:${brand.navy};">
      Verify your email
    </p>
    <p style="margin:0 0 14px;">${greeting}</p>
    <p style="margin:0 0 14px;">
      Tap the button below to confirm your email address. The link expires in
      <strong>${payload.expiresInMinutes} minutes</strong>.
    </p>
    <p style="margin:0 0 14px;color:${brand.muted};font-size:13px;">
      If the button doesn't work, copy and paste this URL into your browser:<br>
      <span style="word-break:break-all;color:${brand.navy};">${escapeText(payload.verificationUrl)}</span>
    </p>
    <p style="margin:24px 0 0;color:${brand.muted};font-size:12px;">
      If you didn't sign up for Bondzi, you can safely ignore this email.
    </p>
  `;
  return {
    subject: 'Confirm your Bondzi email',
    html: renderLayout({
      title: 'Verify email',
      preheader: `Verify your email — link expires in ${payload.expiresInMinutes} minutes.`,
      body,
      cta: { label: 'Verify email', url: payload.verificationUrl },
      webUrl,
    }),
    text:
      `${greeting}\n\nVerify your Bondzi email by opening this link ` +
      `(expires in ${payload.expiresInMinutes} minutes):\n\n${payload.verificationUrl}\n\n` +
      `If you didn't sign up for Bondzi, ignore this message.`,
  };
}
