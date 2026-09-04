/**
 * Admin broadcast / marketing announcement — the EMAIL leg of the
 * notifications broadcast (NotificationChannel.EMAIL). Title/body are
 * admin-authored plain text; both are escaped here and the body's
 * newlines become paragraphs. The unsubscribe link is mandatory in
 * spirit: MailService always passes it, and the footer renders it
 * whenever present (marketing to an audience with many minors gets a
 * one-click opt-out, no exceptions).
 */
import { AnnouncementPayload, BuiltMail } from '../mail.types';
import { brand, escapeAttr, escapeText, renderLayout } from './_layout';

export function buildAnnouncement(
  payload: AnnouncementPayload,
  webUrl: string,
): BuiltMail {
  const paragraphs = payload.body
    .split(/\n{1,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 14px;">${escapeText(p)}</p>`)
    .join('\n');
  const unsub = payload.unsubscribeUrl
    ? `<p style="margin:18px 0 0;font-size:12px;color:${brand.muted};">
         You're receiving this because you have a Bondzi account.
         <a href="${escapeAttr(payload.unsubscribeUrl)}" style="color:${brand.muted};">Unsubscribe from announcements</a>
       </p>`
    : '';
  const body = `
    <p style="margin:0 0 14px;font-size:20px;font-weight:700;color:${brand.navy};">
      ${escapeText(payload.title)}
    </p>
    ${paragraphs}
    <p style="margin:0 0 6px;">— The Bondzi team</p>
    ${unsub}
  `;
  return {
    subject: payload.title,
    html: renderLayout({
      title: payload.title,
      preheader: payload.body.slice(0, 120),
      body,
      cta: { label: 'Open Bondzi', url: webUrl },
      webUrl,
    }),
    text:
      `${payload.title}\n\n${payload.body}\n\nOpen Bondzi: ${webUrl}` +
      (payload.unsubscribeUrl
        ? `\n\nUnsubscribe from announcements: ${payload.unsubscribeUrl}`
        : ''),
  };
}
