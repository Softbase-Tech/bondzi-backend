/**
 * Engagement / lifecycle emails — streak nudges, level-ups, referral
 * confirmations, weekly digest. None carry attachments.
 *
 * Grouped in one file by category (vs five separate ~25-line modules)
 * because they share the same friendly tone and template structure;
 * splitting would mean duplicating the same greet/CTA/footer wiring
 * across each file.
 */
import {
  BuiltMail,
  LevelUpPayload,
  ReferralQualifiedPayload,
  StreakAtRiskPayload,
  StudyReminderPayload,
  WeeklyDigestPayload,
} from '../mail.types';
import {
  brand,
  escapeAttr,
  escapeText,
  formatDate,
  renderLayout,
} from './_layout';

function greet(name: string | undefined): string {
  return name ? `Hi ${escapeText(name)},` : 'Hi there,';
}

export function buildStreakAtRisk(
  payload: StreakAtRiskPayload,
  webUrl: string,
): BuiltMail {
  const body = `
    <p style="margin:0 0 14px;font-size:20px;font-weight:700;color:${brand.navy};">
      🔥 Don't lose your streak
    </p>
    <p style="margin:0 0 14px;">${greet(payload.recipientName)}</p>
    <p style="margin:0 0 14px;">
      Your <strong>${payload.streakDays}-day</strong> Bondzi streak is about to reset.
      A single practice question before <strong>${escapeText(formatDate(payload.expiresAt))}</strong>
      keeps it alive.
    </p>
    <p style="margin:0 0 6px;">— The Bondzi team</p>
  `;
  return {
    subject: `🔥 ${payload.streakDays}-day streak about to reset`,
    html: renderLayout({
      title: 'Streak at risk',
      preheader: `One question keeps your ${payload.streakDays}-day streak alive.`,
      body,
      cta: { label: 'Practise now', url: webUrl },
      webUrl,
    }),
    text:
      `${greet(payload.recipientName).replace(/<[^>]+>/g, '')}\n\n` +
      `Your ${payload.streakDays}-day Bondzi streak is about to reset. ` +
      `Answer one question before ${formatDate(payload.expiresAt)} to keep it alive.\n\n` +
      `Open Bondzi: ${webUrl}`,
  };
}

/**
 * Study-reminder email — the fallback channel for users with no
 * push-capable device (web signups). Deliberately gentler than the
 * daily push: it arrives at most every 3rd day per user, so the copy
 * reads like a nudge, not a nag.
 */
export function buildStudyReminder(
  payload: StudyReminderPayload,
  webUrl: string,
): BuiltMail {
  const hasStreak = payload.streakDays > 0;
  const headline = hasStreak
    ? `Keep your ${payload.streakDays}-day streak going`
    : 'A few questions today goes a long way';
  const line = hasStreak
    ? `Your <strong>${payload.streakDays}-day</strong> streak is waiting — one short practice session today keeps it alive.`
    : `Pick one subject and try a short practice set — ten questions is enough to see where you stand.`;
  const unsub = payload.unsubscribeUrl
    ? `<p style="margin:18px 0 0;font-size:12px;color:${brand.muted};">
         Not helpful? <a href="${escapeAttr(payload.unsubscribeUrl)}" style="color:${brand.muted};">Unsubscribe from study reminders</a>
       </p>`
    : '';
  const body = `
    <p style="margin:0 0 14px;font-size:20px;font-weight:700;color:${brand.navy};">
      📚 ${headline}
    </p>
    <p style="margin:0 0 14px;">${greet(payload.recipientName)}</p>
    <p style="margin:0 0 14px;">${line}</p>
    <p style="margin:0 0 6px;">— The Bondzi team</p>
    ${unsub}
  `;
  return {
    subject: hasStreak
      ? `📚 Your ${payload.streakDays}-day streak is waiting`
      : '📚 Ready for a quick practice session?',
    html: renderLayout({
      title: 'Study reminder',
      preheader: hasStreak
        ? `One session keeps your ${payload.streakDays}-day streak alive.`
        : 'A short practice set today goes a long way.',
      body,
      cta: { label: 'Practise now', url: webUrl },
      webUrl,
    }),
    text:
      `${greet(payload.recipientName).replace(/<[^>]+>/g, '')}\n\n` +
      (hasStreak
        ? `Your ${payload.streakDays}-day Bondzi streak is waiting — one short practice session today keeps it alive.\n\n`
        : `Pick one subject and try a short practice set — ten questions is enough to see where you stand.\n\n`) +
      `Open Bondzi: ${webUrl}` +
      (payload.unsubscribeUrl
        ? `\n\nUnsubscribe from study reminders: ${payload.unsubscribeUrl}`
        : ''),
  };
}

export function buildLevelUp(
  payload: LevelUpPayload,
  webUrl: string,
): BuiltMail {
  const body = `
    <p style="margin:0 0 14px;font-size:20px;font-weight:700;color:${brand.navy};">
      🎉 You levelled up
    </p>
    <p style="margin:0 0 14px;">${greet(payload.recipientName)}</p>
    <p style="margin:0 0 14px;">
      You earned <strong>${payload.xpEarned} XP</strong> and reached
      <strong>Level ${payload.newLevel}</strong>. Keep going — every level unlocks
      something new in your Bondzi profile.
    </p>
    <p style="margin:0 0 6px;">— The Bondzi team</p>
  `;
  return {
    subject: `🎉 Level ${payload.newLevel} unlocked`,
    html: renderLayout({
      title: 'Level up',
      preheader: `You're now Level ${payload.newLevel}.`,
      body,
      cta: { label: 'See your profile', url: webUrl },
      webUrl,
    }),
    text:
      `You earned ${payload.xpEarned} XP and reached Level ${payload.newLevel}. ` +
      `Open Bondzi: ${webUrl}`,
  };
}

export function buildReferralQualified(
  payload: ReferralQualifiedPayload,
  webUrl: string,
): BuiltMail {
  const body = `
    <p style="margin:0 0 14px;font-size:20px;font-weight:700;color:${brand.navy};">
      🙌 Your referral just upgraded
    </p>
    <p style="margin:0 0 14px;">${greet(payload.recipientName)}</p>
    <p style="margin:0 0 14px;">
      <strong>${escapeText(payload.refereeName)}</strong> just upgraded their Bondzi
      account using your referral code — we've credited you with
      <strong>${payload.rewardXp} XP</strong>.
    </p>
    <p style="margin:0 0 14px;">
      Keep sharing your code from the Referrals tab and stack up XP towards a free
      month of Pro.
    </p>
    <p style="margin:0 0 6px;">— The Bondzi team</p>
  `;
  return {
    subject: `🙌 ${payload.refereeName} just upgraded — +${payload.rewardXp} XP`,
    html: renderLayout({
      title: 'Referral qualified',
      preheader: `+${payload.rewardXp} XP for referring ${payload.refereeName}.`,
      body,
      cta: { label: 'Share your code', url: webUrl },
      webUrl,
    }),
    text:
      `${payload.refereeName} upgraded using your referral code — +${payload.rewardXp} XP credited.\n\n` +
      `Open Bondzi: ${webUrl}`,
  };
}

export function buildWeeklyDigest(
  payload: WeeklyDigestPayload,
  webUrl: string,
): BuiltMail {
  const rankSymbol =
    payload.rankDelta > 0 ? '▲' : payload.rankDelta < 0 ? '▼' : '–';
  const rankColour =
    payload.rankDelta > 0
      ? '#06D6A0'
      : payload.rankDelta < 0
        ? brand.orange
        : brand.muted;
  const body = `
    <p style="margin:0 0 14px;font-size:20px;font-weight:700;color:${brand.navy};">
      Your week on Bondzi
    </p>
    <p style="margin:0 0 14px;">${greet(payload.recipientName)}</p>
    <p style="margin:0 0 14px;">Here's how the last 7 days went:</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="margin:18px 0;border:1px solid #ECECF0;border-radius:10px;
                  font-family:Helvetica,Arial,sans-serif;font-size:14px;">
      <tr><td style="padding:10px 14px;color:${brand.muted};">Questions answered</td>
          <td style="padding:10px 14px;text-align:right;font-weight:700;">${payload.questionsAnswered}</td></tr>
      <tr><td style="padding:10px 14px;color:${brand.muted};border-top:1px solid #ECECF0;">Correct rate</td>
          <td style="padding:10px 14px;text-align:right;font-weight:700;border-top:1px solid #ECECF0;">${Math.round(payload.correctRate * 100)}%</td></tr>
      <tr><td style="padding:10px 14px;color:${brand.muted};border-top:1px solid #ECECF0;">XP earned</td>
          <td style="padding:10px 14px;text-align:right;font-weight:700;border-top:1px solid #ECECF0;">${payload.xpThisWeek}</td></tr>
      <tr><td style="padding:10px 14px;color:${brand.muted};border-top:1px solid #ECECF0;">Streak</td>
          <td style="padding:10px 14px;text-align:right;font-weight:700;border-top:1px solid #ECECF0;">🔥 ${payload.currentStreak} day${payload.currentStreak === 1 ? '' : 's'}</td></tr>
      <tr><td style="padding:10px 14px;color:${brand.muted};border-top:1px solid #ECECF0;">Rank change</td>
          <td style="padding:10px 14px;text-align:right;font-weight:700;color:${rankColour};border-top:1px solid #ECECF0;">${rankSymbol} ${Math.abs(payload.rankDelta)}</td></tr>
    </table>

    <p style="margin:0 0 14px;">Keep at it — exam prep is a marathon, not a sprint.</p>
    ${
      payload.unsubscribeUrl
        ? `<p style="margin:16px 0 0;font-size:11px;color:${brand.muted};">
             <a href="${escapeAttr(payload.unsubscribeUrl)}" style="color:${brand.muted};">Unsubscribe</a>
             from weekly digests and engagement emails.
           </p>`
        : ''
    }
    <p style="margin:0 0 6px;">— The Bondzi team</p>
  `;
  const textUnsub = payload.unsubscribeUrl
    ? `\n\nUnsubscribe: ${payload.unsubscribeUrl}`
    : '';
  return {
    subject: `📈 ${payload.questionsAnswered} questions, ${payload.xpThisWeek} XP this week`,
    html: renderLayout({
      title: 'Weekly digest',
      preheader: `${payload.questionsAnswered} questions · ${Math.round(payload.correctRate * 100)}% correct · ${payload.xpThisWeek} XP.`,
      body,
      cta: { label: 'Open Bondzi', url: webUrl },
      webUrl,
    }),
    text:
      `Questions: ${payload.questionsAnswered}, correct rate: ${Math.round(payload.correctRate * 100)}%, ` +
      `XP: ${payload.xpThisWeek}, streak: ${payload.currentStreak} days.\n\n` +
      `Open Bondzi: ${webUrl}${textUnsub}`,
  };
}
