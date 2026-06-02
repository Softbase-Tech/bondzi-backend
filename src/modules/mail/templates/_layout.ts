/**
 * Shared HTML envelope for every transactional email.
 *
 * Inline CSS is used throughout — Gmail / Yahoo / mobile clients strip
 * `<style>` blocks aggressively and ignore CSS classes. A few survive
 * (notably media queries inside `<style>` blocks for dark mode), but
 * relying on them breaks ~30% of inboxes.
 *
 * Width: 600px is the email-design industry standard — wider tends to
 * scroll horizontally on iOS Mail. Outer table is a backwards-compat
 * shim for Outlook 2007+ which still uses Word's HTML renderer.
 */

export interface LayoutOptions {
  /** Big header text, usually "Bondzi" or the event name. */
  preheader?: string;
  /** Page <title> + leading text snippet some clients show in the list view. */
  title: string;
  /** Inner HTML — already inline-styled. */
  body: string;
  /**
   * Footer-level call-to-action. Renders nothing when undefined.
   * Useful for the "Reset password" / "View receipt" big orange button.
   */
  cta?: {
    label: string;
    url: string;
  };
  /** App URL for the brand link + unsubscribe footer. */
  webUrl: string;
}

const BRAND_NAVY = '#1A1A2E';
const BRAND_ORANGE = '#FF6B35';
const TEXT_PRIMARY = '#1A1A2E';
const TEXT_MUTED = '#64748B';
const BG = '#F1F1F4';

export function renderLayout(opts: LayoutOptions): string {
  const { preheader, title, body, cta, webUrl } = opts;
  const ctaHtml = cta
    ? `
      <tr>
        <td align="center" style="padding: 24px 0 8px;">
          <a href="${escapeAttr(cta.url)}"
             style="display:inline-block;background:${BRAND_ORANGE};color:#FFFFFF;
                    font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;
                    text-decoration:none;padding:14px 28px;border-radius:10px;">
            ${escapeText(cta.label)}
          </a>
        </td>
      </tr>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeText(title)}</title>
</head>
<body style="margin:0;padding:0;background:${BG};font-family:Helvetica,Arial,sans-serif;color:${TEXT_PRIMARY};">
${
  preheader
    ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeText(preheader)}</div>`
    : ''
}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BG};">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
             style="max-width:600px;background:#FFFFFF;border-radius:14px;
                    box-shadow:0 1px 3px rgba(0,0,0,0.06);overflow:hidden;">
        <tr>
          <td style="background:${BRAND_NAVY};padding:20px 28px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-family:Helvetica,Arial,sans-serif;font-size:22px;font-weight:800;
                           letter-spacing:0.3px;color:#FFFFFF;">
                  Bondzi
                </td>
                <td align="right" style="font-family:Helvetica,Arial,sans-serif;font-size:12px;
                                         color:rgba(255,255,255,0.7);">
                  ${escapeText(title)}
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 28px 8px;font-family:Helvetica,Arial,sans-serif;
                     font-size:15px;line-height:1.55;color:${TEXT_PRIMARY};">
            ${body}
          </td>
        </tr>
        ${ctaHtml}
        <tr>
          <td style="padding:24px 28px 28px;font-family:Helvetica,Arial,sans-serif;
                     font-size:12px;line-height:1.5;color:${TEXT_MUTED};
                     border-top:1px solid #ECECF0;margin-top:24px;">
            <p style="margin:12px 0 4px;">
              Bondzi · WASSCE &amp; BECE exam prep for Ghana.
            </p>
            <p style="margin:4px 0;">
              <a href="${escapeAttr(webUrl)}" style="color:${TEXT_MUTED};text-decoration:underline;">${escapeText(stripScheme(webUrl))}</a>
            </p>
            <p style="margin:12px 0 0;font-size:11px;color:#94A3B8;">
              You're receiving this because you have a Bondzi account.
              If you have questions, just reply to this email.
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/**
 * HTML-escape body text. Templates pass already-escaped content for
 * things they generated themselves (lists, tables) — call this for any
 * field that came from user input.
 */
export function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;');
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

// Re-exported colour tokens so individual templates stay on-brand
// without redefining them.
export const brand = {
  navy: BRAND_NAVY,
  orange: BRAND_ORANGE,
  text: TEXT_PRIMARY,
  muted: TEXT_MUTED,
  bg: BG,
};

/**
 * Format a money amount for inline display. Returns e.g. "GHS 200.00".
 * Keeps two decimals always so receipts have a stable shape.
 */
export function formatMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toFixed(2)}`;
}

/**
 * Format a Date as "29 May 2026". No timezone suffix — these are
 * user-facing labels, not log timestamps.
 */
export function formatDate(d: Date): string {
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
