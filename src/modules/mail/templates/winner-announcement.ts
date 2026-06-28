import { BuiltMail, WinnerAnnouncementPayload } from '../mail.types';
import { brand, escapeText, renderLayout } from './_layout';

const RANK_SUFFIX: Record<number, string> = { 1: 'st', 2: 'nd', 3: 'rd' };
function ordinalRank(n: number): string {
  return `${n}${RANK_SUFFIX[n] ?? 'th'}`;
}

const PERIOD_LABEL: Record<string, string> = {
  weekly: 'this week',
  monthly: 'this month',
  yearly: 'this year',
};

/**
 * Leaderboard winner congratulations. Fires from
 * WinnerSelectionService for weekly / monthly / yearly periods. The
 * email also acts as a "claim your XP" nudge — the XP is already
 * banked server-side, but the copy points the user at the
 * leaderboard tab so they see their position.
 */
export function buildWinnerAnnouncement(
  payload: WinnerAnnouncementPayload,
  webUrl: string,
): BuiltMail {
  const greeting = payload.recipientName
    ? `Hi ${escapeText(payload.recipientName)},`
    : 'Hi there,';
  const rankLabel = ordinalRank(payload.rank);
  const periodLabel = PERIOD_LABEL[payload.period] ?? payload.period;
  const body = `
    <p style="margin:0 0 14px;font-size:22px;font-weight:800;color:${brand.navy};">
      🏆 You finished ${escapeText(rankLabel)} ${escapeText(periodLabel)}!
    </p>
    <p style="margin:0 0 14px;">${greeting}</p>
    <p style="margin:0 0 14px;">
      The ${escapeText(payload.period)} leaderboard for
      <strong>${escapeText(payload.level)}</strong> just closed —
      you placed <strong>${escapeText(rankLabel)}</strong>.
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
    subject: `🏆 ${rankLabel} place ${periodLabel} on Bondzi!`,
    html: renderLayout({
      title: 'You won!',
      preheader: `${rankLabel} place ${periodLabel} — +${payload.xpAwarded.toLocaleString()} XP.`,
      body,
      cta: { label: 'See the leaderboard', url: webUrl },
      webUrl,
    }),
    text:
      `${greeting}\n\n` +
      `Congrats — you placed ${rankLabel} ${periodLabel} on the ${payload.level} board. ` +
      `+${payload.xpAwarded} XP awarded to your account.\n\n` +
      `Next ${payload.period}'s board is already open.`,
  };
}
