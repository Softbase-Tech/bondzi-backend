import { BuiltMail, WinnerAnnouncementPayload } from '../mail.types';
import { brand, escapeText, renderLayout } from './_layout';

const RANK_SUFFIX: Record<number, string> = { 1: 'st', 2: 'nd', 3: 'rd' };
function ordinalRank(n: number): string {
  return `${n}${RANK_SUFFIX[n] ?? 'th'}`;
}

/**
 * Leaderboard winner congratulations. Fires from
 * WinnerSelectionService for weekly / monthly / yearly periods. Copy
 * anchors on `payload.periodLabel` — a specific dated label like
 * "the week of 3–9 Aug 2026" or "August 2026" — not "this week /
 * this month". Awarding can lag past the current period, so the
 * relative phrasing was misleading.
 */
export function buildWinnerAnnouncement(
  payload: WinnerAnnouncementPayload,
  webUrl: string,
): BuiltMail {
  const greeting = payload.recipientName
    ? `Hi ${escapeText(payload.recipientName)},`
    : 'Hi there,';
  const rankLabel = ordinalRank(payload.rank);
  const specific = escapeText(payload.periodLabel);
  const body = `
    <p style="margin:0 0 14px;font-size:22px;font-weight:800;color:${brand.navy};">
      🏆 You finished ${escapeText(rankLabel)} for ${specific}!
    </p>
    <p style="margin:0 0 14px;">${greeting}</p>
    <p style="margin:0 0 14px;">
      The ${escapeText(payload.period)} leaderboard for
      <strong>${escapeText(payload.level)}</strong> — for
      <strong>${specific}</strong> — just closed. You placed
      <strong>${escapeText(rankLabel)}</strong>.
    </p>
    <div style="
      margin:18px 0;
      padding:14px 16px;
      background:#FFFBEB;
      border:1px solid #FFD93D;
      border-radius:10px;
      color:${brand.navy};
      font-size:14px;
    ">
      <strong style="font-size:16px;">+${payload.xpAwarded.toLocaleString()} XP</strong>
      <span style="color:${brand.muted};">awarded to your account</span>
    </div>
    <p style="margin:0 0 14px;">
      Keep going — next ${escapeText(payload.period)}'s board is already open.
    </p>
  `;
  return {
    subject: `🏆 ${rankLabel} place for ${payload.periodLabel} on Bondzi!`,
    html: renderLayout({
      title: 'You won!',
      preheader: `${rankLabel} place for ${payload.periodLabel} — +${payload.xpAwarded.toLocaleString()} XP.`,
      body,
      cta: { label: 'See the leaderboard', url: webUrl },
      webUrl,
    }),
    text:
      `${greeting}\n\n` +
      `Congrats — you placed ${rankLabel} for ${payload.periodLabel} on the ${payload.level} board. ` +
      `+${payload.xpAwarded} XP awarded to your account.\n\n` +
      `Next ${payload.period}'s board is already open.`,
  };
}
