import { BuiltMail, EmailOtpPayload } from '../mail.types';
import { brand, escapeText, renderLayout } from './_layout';

/**
 * Pre-registration email OTP. The user just typed their address into
 * the mobile signup screen; we send them a 6-digit code to prove
 * they control the inbox before we create the account. Distinct
 * from EMAIL_VERIFICATION which sends a clickable link to an
 * already-existing account.
 *
 * The code is rendered large + monospace so it copy-pastes cleanly
 * on mobile email clients. We intentionally do NOT include a click
 * link — typing the code keeps the verification bound to the device
 * that started the signup.
 */
export function buildEmailOtp(
  payload: EmailOtpPayload,
  webUrl: string,
): BuiltMail {
  const greeting = payload.recipientName
    ? `Hi ${escapeText(payload.recipientName)},`
    : 'Hi there,';
  const body = `
    <p style="margin:0 0 14px;font-size:20px;font-weight:700;color:${brand.navy};">
      Your Bondzi verification code
    </p>
    <p style="margin:0 0 14px;">${greeting}</p>
    <p style="margin:0 0 14px;">
      Enter the code below in the app to finish creating your account.
      It expires in <strong>${payload.expiresInMinutes} minutes</strong>.
    </p>
    <div style="
      margin:20px auto;
      padding:16px 24px;
      background:#FFF7F4;
      border:2px solid ${brand.orange};
      border-radius:12px;
      text-align:center;
      font-family:'Courier New', monospace;
      font-size:32px;
      font-weight:800;
      letter-spacing:8px;
      color:${brand.navy};
    ">
      ${escapeText(payload.code)}
    </div>
    <p style="margin:24px 0 0;color:${brand.muted};font-size:12px;">
      If you didn't try to sign up for Bondzi, you can safely ignore
      this email — no account is created without entering the code.
    </p>
  `;
  return {
    subject: `Bondzi verification code: ${payload.code}`,
    html: renderLayout({
      title: 'Verification code',
      preheader: `Your Bondzi code is ${payload.code} — expires in ${payload.expiresInMinutes} minutes.`,
      body,
      webUrl,
    }),
    text:
      `${greeting}\n\n` +
      `Your Bondzi verification code is: ${payload.code}\n` +
      `It expires in ${payload.expiresInMinutes} minutes.\n\n` +
      `If you didn't try to sign up for Bondzi, ignore this message.`,
  };
}
