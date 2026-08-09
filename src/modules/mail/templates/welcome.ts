import { BuiltMail, WelcomePayload } from '../mail.types';
import { brand, escapeText, renderLayout } from './_layout';

export function buildWelcomeEmail(
  payload: WelcomePayload,
  webUrl: string,
): BuiltMail {
  const greeting = payload.recipientName
    ? `Hi ${escapeText(payload.recipientName)},`
    : 'Hi there,';
  const body = `
    <p style="margin:0 0 14px;font-size:20px;font-weight:700;color:${brand.navy};">
      Welcome to Bondzi
    </p>
    <p style="margin:0 0 14px;">${greeting}</p>
    <p style="margin:0 0 14px;">
      Your <strong>${escapeText(payload.examType)}</strong> exam-prep account is ready.
      You can start practising past papers, take adaptive quizzes, and build a daily
      study streak right away — free.
    </p>
    <p style="margin:0 0 14px;">
      When you're ready for more, upgrade to <strong>Plus</strong> for lifetime
      access to electives and AI explanations, or <strong>Pro</strong> for AI-generated
      tests, weakness analytics, and curated drills.
    </p>
    <p style="margin:0 0 6px;">— The Bondzi team</p>
  `;
  return {
    subject: 'Welcome to Bondzi 🎉',
    html: renderLayout({
      title: 'Welcome',
      preheader: 'Your Bondzi account is ready — start practising now.',
      body,
      cta: { label: 'Open Bondzi', url: webUrl },
      webUrl,
    }),
    text:
      `${greeting}\n\n` +
      `Your ${payload.examType} exam-prep account is ready. ` +
      `Start practising past papers, take adaptive quizzes, and build a daily streak — free.\n\n` +
      `When you're ready for more, upgrade to Plus for lifetime access to electives and ` +
      `AI explanations, or Pro for AI-generated tests, weakness analytics and curated drills.\n\n` +
      `Open Bondzi: ${webUrl}\n\n` +
      `— The Bondzi team`,
  };
}
