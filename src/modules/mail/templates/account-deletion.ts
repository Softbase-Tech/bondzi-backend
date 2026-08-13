/**
 * Account-deletion lifecycle emails:
 *   - warning  (T-14 / T-7 before the account is removed)
 *   - deleted  (confirmation after anonymisation)
 *   - admin digest (internal daily summary)
 *
 * The two user-facing ones are transactional (critical account notices) —
 * see TRANSACTIONAL_MAIL_EVENTS.
 */
import {
  AccountDeletedPayload,
  AccountDeletionWarningPayload,
  AdminAccountDeletionDigestPayload,
  BuiltMail,
} from '../mail.types';
import { brand, escapeText, renderLayout } from './_layout';

function greet(name: string | undefined): string {
  return name ? `Hi ${escapeText(name)},` : 'Hi there,';
}

export function buildAccountDeletionWarning(
  payload: AccountDeletionWarningPayload,
  webUrl: string,
): BuiltMail {
  const { daysLeft, deleteOnDate, reason } = payload;
  const lead =
    reason === 'user_requested'
      ? 'You asked us to delete your Bondzi account.'
      : `Your Bondzi account has been inactive for a while, so it's scheduled for deletion.`;
  const body = `
    <p style="margin:0 0 14px;font-size:20px;font-weight:700;color:${brand.navy};">
      Your account will be deleted in ${daysLeft} day${daysLeft === 1 ? '' : 's'}
    </p>
    <p style="margin:0 0 14px;">${greet(payload.recipientName)}</p>
    <p style="margin:0 0 14px;">
      ${escapeText(lead)} Unless you sign back in, your account and all its data
      will be permanently removed on
      <strong>${escapeText(deleteOnDate)}</strong>.
    </p>
    <p style="margin:0 0 14px;">
      <strong>Want to keep it?</strong> Just log in before then — that cancels the
      deletion and nothing is lost.
    </p>
    <p style="margin:0 0 6px;">— The Bondzi team</p>
  `;
  return {
    subject: `Your Bondzi account will be deleted in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
    html: renderLayout({
      title: 'Account scheduled for deletion',
      preheader: `Log in before ${deleteOnDate} to keep your account.`,
      body,
      cta: { label: 'Log in to keep my account', url: webUrl },
      webUrl,
    }),
    text:
      `${greet(payload.recipientName).replace(/<[^>]+>/g, '')}\n\n` +
      `${lead} Unless you sign back in, your account and all its data will be ` +
      `permanently removed on ${deleteOnDate}.\n\n` +
      `Want to keep it? Log in before then to cancel the deletion: ${webUrl}\n\n` +
      `— The Bondzi team`,
  };
}

export function buildAccountDeleted(
  payload: AccountDeletedPayload,
  webUrl: string,
): BuiltMail {
  const body = `
    <p style="margin:0 0 14px;font-size:20px;font-weight:700;color:${brand.navy};">
      Your Bondzi account has been deleted
    </p>
    <p style="margin:0 0 14px;">${greet(payload.recipientName)}</p>
    <p style="margin:0 0 14px;">
      As scheduled, your Bondzi account and personal data were permanently
      removed on <strong>${escapeText(payload.deletedOnDate)}</strong>.
    </p>
    <p style="margin:0 0 14px;">
      Thanks for studying with us. You're always welcome back — creating a new
      account starts you fresh any time.
    </p>
    <p style="margin:0 0 6px;">— The Bondzi team</p>
  `;
  return {
    subject: 'Your Bondzi account has been deleted',
    html: renderLayout({
      title: 'Account deleted',
      preheader: 'Your Bondzi account and data have been removed.',
      body,
      cta: { label: 'Create a new account', url: webUrl },
      webUrl,
    }),
    text:
      `${greet(payload.recipientName).replace(/<[^>]+>/g, '')}\n\n` +
      `As scheduled, your Bondzi account and personal data were permanently ` +
      `removed on ${payload.deletedOnDate}.\n\n` +
      `You're always welcome back at ${webUrl}.\n\n— The Bondzi team`,
  };
}

export function buildAdminAccountDeletionDigest(
  payload: AdminAccountDeletionDigestPayload,
  webUrl: string,
): BuiltMail {
  const samples =
    payload.deletedSamples.length > 0
      ? `<ul style="margin:0 0 14px;padding-left:18px;">${payload.deletedSamples
          .map((s) => `<li style="margin:0 0 4px;">${escapeText(s)}</li>`)
          .join('')}</ul>`
      : '<p style="margin:0 0 14px;color:#64748B;">No accounts deleted today.</p>';
  const body = `
    <p style="margin:0 0 14px;font-size:20px;font-weight:700;color:${brand.navy};">
      Account deletions — ${escapeText(payload.dateKey)}
    </p>
    <p style="margin:0 0 6px;"><strong>${payload.scheduledCount}</strong> newly scheduled</p>
    <p style="margin:0 0 6px;"><strong>${payload.warnedCount}</strong> warned (T-14 / T-7)</p>
    <p style="margin:0 0 14px;"><strong>${payload.deletedCount}</strong> deleted (anonymised)</p>
    ${samples}
    <p style="margin:0 0 6px;color:#64748B;font-size:13px;">Automated internal digest — Bondzi.</p>
  `;
  return {
    subject: `[Bondzi] Account deletions ${payload.dateKey}: ${payload.deletedCount} deleted, ${payload.scheduledCount} scheduled`,
    html: renderLayout({
      title: 'Account deletion digest',
      preheader: `${payload.deletedCount} deleted, ${payload.scheduledCount} scheduled.`,
      body,
      webUrl,
    }),
    text:
      `Account deletions — ${payload.dateKey}\n` +
      `${payload.scheduledCount} newly scheduled\n` +
      `${payload.warnedCount} warned\n` +
      `${payload.deletedCount} deleted (anonymised)\n\n` +
      payload.deletedSamples.map((s) => `- ${s}`).join('\n'),
  };
}
