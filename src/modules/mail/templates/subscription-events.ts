/**
 * Subscription lifecycle emails (renewed, expiring, expired, cancelled,
 * payment-failed). Each is a thin wrapper around the shared layout —
 * no PDF attachments because these aren't financial-record events.
 *
 * Kept together in one file because they share copy/structure; splitting
 * would mean four near-identical 30-line modules.
 */
import {
  BuiltMail,
  SubscriptionCancelledPayload,
  SubscriptionExpiredPayload,
  SubscriptionExpiringSoonPayload,
  SubscriptionPaymentFailedPayload,
  SubscriptionRenewedPayload,
} from '../mail.types';
import {
  brand,
  escapeText,
  formatDate,
  formatMoney,
  renderLayout,
} from './_layout';

function greet(name: string | undefined): string {
  return name ? `Hi ${escapeText(name)},` : 'Hi there,';
}

export function buildSubscriptionRenewed(
  payload: SubscriptionRenewedPayload,
  webUrl: string,
): BuiltMail {
  const body = `
    <p style="margin:0 0 14px;font-size:20px;font-weight:700;color:${brand.navy};">
      Subscription renewed
    </p>
    <p style="margin:0 0 14px;">${greet(payload.recipientName)}</p>
    <p style="margin:0 0 14px;">
      Your <strong>${escapeText(payload.planName)}</strong> subscription renewed for
      <strong>${escapeText(formatMoney(payload.amountDisplay, payload.currency))}</strong>.
      Your receipt is attached to this email.
    </p>
    <p style="margin:0 0 14px;">Next renewal: <strong>${escapeText(formatDate(payload.nextRenewalAt))}</strong></p>
    <p style="margin:0 0 14px;color:${brand.muted};font-size:13px;">Reference: ${escapeText(payload.reference)}</p>
    <p style="margin:0 0 6px;">— The Bondzi team</p>
  `;
  return {
    subject: `Subscription renewed — ${payload.planName}`,
    html: renderLayout({
      title: 'Subscription renewed',
      preheader: `Renewed for ${formatMoney(payload.amountDisplay, payload.currency)}.`,
      body,
      cta: { label: 'Open Bondzi', url: webUrl },
      webUrl,
    }),
  };
}

export function buildSubscriptionExpiringSoon(
  payload: SubscriptionExpiringSoonPayload,
  webUrl: string,
): BuiltMail {
  const body = `
    <p style="margin:0 0 14px;font-size:20px;font-weight:700;color:${brand.navy};">
      Your Pro subscription expires soon
    </p>
    <p style="margin:0 0 14px;">${greet(payload.recipientName)}</p>
    <p style="margin:0 0 14px;">
      Your <strong>${escapeText(payload.planName)}</strong> subscription for
      <strong>${escapeText(payload.level)}</strong> expires in
      <strong>${payload.daysRemaining} day${payload.daysRemaining === 1 ? '' : 's'}</strong>
      (<strong>${escapeText(formatDate(payload.expiresAt))}</strong>).
    </p>
    <p style="margin:0 0 14px;">
      Renew now to keep your AI tests, analytics and curated drills.
    </p>
    <p style="margin:0 0 6px;">— The Bondzi team</p>
  `;
  return {
    subject: `Pro expires in ${payload.daysRemaining} day${payload.daysRemaining === 1 ? '' : 's'}`,
    html: renderLayout({
      title: 'Pro expires soon',
      preheader: `${payload.planName} expires ${formatDate(payload.expiresAt)}.`,
      body,
      cta: { label: 'Renew now', url: webUrl },
      webUrl,
    }),
  };
}

export function buildSubscriptionExpired(
  payload: SubscriptionExpiredPayload,
  webUrl: string,
): BuiltMail {
  const body = `
    <p style="margin:0 0 14px;font-size:20px;font-weight:700;color:${brand.navy};">
      Your Pro subscription has expired
    </p>
    <p style="margin:0 0 14px;">${greet(payload.recipientName)}</p>
    <p style="margin:0 0 14px;">
      Your <strong>${escapeText(payload.planName)}</strong> subscription for
      <strong>${escapeText(payload.level)}</strong> expired on
      <strong>${escapeText(formatDate(payload.expiredAt))}</strong>.
      Pro-only features (AI tests, analytics, weakness assessments) are now locked
      for ${escapeText(payload.level)} — past papers, practice and AI explanations
      stay open if you also hold Plus on this level.
    </p>
    <p style="margin:0 0 14px;">Renew to pick up where you left off.</p>
    <p style="margin:0 0 6px;">— The Bondzi team</p>
  `;
  return {
    subject: `Pro expired — ${payload.level}`,
    html: renderLayout({
      title: 'Pro expired',
      preheader: `${payload.planName} expired on ${formatDate(payload.expiredAt)}.`,
      body,
      cta: { label: 'Renew now', url: webUrl },
      webUrl,
    }),
  };
}

export function buildSubscriptionCancelled(
  payload: SubscriptionCancelledPayload,
  webUrl: string,
): BuiltMail {
  const body = `
    <p style="margin:0 0 14px;font-size:20px;font-weight:700;color:${brand.navy};">
      Subscription cancelled
    </p>
    <p style="margin:0 0 14px;">${greet(payload.recipientName)}</p>
    <p style="margin:0 0 14px;">
      We've cancelled your <strong>${escapeText(payload.planName)}</strong> subscription
      as requested. You'll keep Pro access for ${escapeText(payload.level)} until
      <strong>${escapeText(formatDate(payload.accessUntil))}</strong> — no further
      payments will be taken.
    </p>
    <p style="margin:0 0 14px;color:${brand.muted};font-size:13px;">
      Changed your mind? You can re-subscribe any time from
      Settings → Subscription.
    </p>
    <p style="margin:0 0 6px;">— The Bondzi team</p>
  `;
  return {
    subject: `Subscription cancelled — ${payload.level}`,
    html: renderLayout({
      title: 'Subscription cancelled',
      preheader: `Access until ${formatDate(payload.accessUntil)}.`,
      body,
      cta: { label: 'Re-subscribe', url: webUrl },
      webUrl,
    }),
  };
}

export function buildSubscriptionPaymentFailed(
  payload: SubscriptionPaymentFailedPayload,
  webUrl: string,
): BuiltMail {
  const retryLine = payload.nextAttemptAt
    ? `<p style="margin:0 0 14px;">We'll automatically retry on <strong>${escapeText(formatDate(payload.nextAttemptAt))}</strong>. Make sure your payment method has funds before then.</p>`
    : `<p style="margin:0 0 14px;color:${brand.orange};font-weight:700;">This was the final retry — your subscription will lapse unless you renew manually.</p>`;
  // Surface the prepaid access boundary so the user has a concrete
  // deadline rather than a vague "lapse unless" sentence.
  const accessLine = payload.accessUntil
    ? `<p style="margin:0 0 14px;color:${brand.muted};">You keep access until <strong>${escapeText(formatDate(payload.accessUntil))}</strong>. Update your card before then to avoid losing ${escapeText(payload.planName)}.</p>`
    : '';
  const body = `
    <p style="margin:0 0 14px;font-size:20px;font-weight:700;color:${brand.navy};">
      Renewal payment failed
    </p>
    <p style="margin:0 0 14px;">${greet(payload.recipientName)}</p>
    <p style="margin:0 0 14px;">
      We couldn't charge your card on <strong>${escapeText(formatDate(payload.attemptedAt))}</strong>
      for <strong>${escapeText(payload.planName)}</strong>.
    </p>
    ${retryLine}
    ${accessLine}
    <p style="margin:0 0 14px;color:${brand.muted};font-size:13px;">
      Stuck? Reply to this email or message us at
      <a href="mailto:support@bondzi.com" style="color:${brand.orange};text-decoration:none;font-weight:600;">support@bondzi.com</a>
      and a human will help you sort the card out.
    </p>
    <p style="margin:0 0 6px;">— The Bondzi team</p>
  `;
  return {
    subject: 'Renewal payment failed',
    html: renderLayout({
      title: 'Payment failed',
      preheader: `Renewal for ${payload.planName} failed.`,
      body,
      cta: { label: 'Update payment method', url: webUrl },
      webUrl,
    }),
  };
}
