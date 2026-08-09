import { BuiltMail, WinnerSelectionReminderPayload } from '../mail.types';
import { brand, escapeText, formatDate, renderLayout } from './_layout';

/**
 * Internal ops reminder. Sent by WinnerSelectionReminderJob to the
 * configured `WINNER_REMINDER_RECIPIENTS` list when one or more
 * leaderboard periods are awaiting winner selection.
 *
 * The body lists every outstanding (exam_type, period_type,
 * period_start) row so the recipient knows exactly what's on the
 * plate before clicking through. CTA goes to /admin/winners.
 */
export function buildWinnerSelectionReminder(
  payload: WinnerSelectionReminderPayload,
  webUrl: string,
): BuiltMail {
  const rows = payload.pendingPeriods
    .map((p) => {
      const periodStartLabel = formatDate(
        new Date(`${p.periodStart}T00:00:00Z`),
      );
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;font-size:13px;color:${brand.navy};">
          <strong>${escapeText(p.examType)}</strong>
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;font-size:13px;color:${brand.text};">
          ${escapeText(p.periodType)}
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;font-size:13px;color:${brand.text};">
          ${escapeText(periodStartLabel)}
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;font-size:13px;color:${brand.muted};text-align:right;">
          ${p.candidateCount} candidate${p.candidateCount === 1 ? '' : 's'}
        </td>
      </tr>`;
    })
    .join('');

  const greeting = payload.recipientName
    ? `Hi ${escapeText(payload.recipientName)},`
    : 'Hi team,';
  const periodCount = payload.pendingPeriods.length;
  const body = `
    <p style="margin:0 0 14px;font-size:20px;font-weight:700;color:${brand.navy};">
      ${periodCount} leaderboard period${periodCount === 1 ? '' : 's'} awaiting winner selection
    </p>
    <p style="margin:0 0 14px;">${greeting}</p>
    <p style="margin:0 0 14px;">
      The leaderboards below have closed but no winners have been
      picked yet. Click through to /admin/winners to confirm — the
      candidate pool is still queryable and XP prizes can be issued
      retroactively.
    </p>
    <table style="
      width:100%;
      border-collapse:collapse;
      margin:14px 0;
      border:1px solid #E2E8F0;
      border-radius:8px;
    ">
      <thead>
        <tr style="background:#F8FAFC;">
          <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:${brand.muted};text-transform:uppercase;letter-spacing:0.5px;">
            Exam
          </th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:${brand.muted};text-transform:uppercase;letter-spacing:0.5px;">
            Period
          </th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:${brand.muted};text-transform:uppercase;letter-spacing:0.5px;">
            Starting
          </th>
          <th style="padding:8px 12px;text-align:right;font-size:11px;font-weight:600;color:${brand.muted};text-transform:uppercase;letter-spacing:0.5px;">
            Candidates
          </th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin:18px 0 0;color:${brand.muted};font-size:12px;">
      You're receiving this because you're on the Bondzi ops mailing list.
    </p>
  `;
  return {
    subject: `Reminder: ${periodCount} leaderboard period${periodCount === 1 ? '' : 's'} need winners`,
    html: renderLayout({
      title: 'Winner selection pending',
      preheader: `${periodCount} period${periodCount === 1 ? '' : 's'} awaiting winner selection on Bondzi admin.`,
      body,
      cta: { label: 'Open admin → Winners', url: `${webUrl}/admin/winners` },
      webUrl,
    }),
    text:
      `${greeting}\n\n` +
      `${periodCount} leaderboard period${periodCount === 1 ? '' : 's'} are awaiting winner selection:\n\n` +
      payload.pendingPeriods
        .map(
          (p) =>
            `  • ${p.examType} — ${p.periodType} starting ${p.periodStart} (${p.candidateCount} candidates)`,
        )
        .join('\n') +
      `\n\nOpen ${payload.selectUrl} to confirm winners.`,
  };
}
