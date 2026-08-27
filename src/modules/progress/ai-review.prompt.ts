import { STUDENT_DATA_RULES } from '../ai/instruction-layer/student-facing.shell';

/** Recorded on ai_usage_log.prompt_version. */
export const AI_REVIEW_PROMPT_VERSION = 'review-v2';

/**
 * The six sections every personalised AI Study Review must contain, in
 * this order. The validator enforces presence + order; the mobile
 * renderer styles each `## Heading`. Keep these labels in lock-step
 * with AI_REVIEW_SECTIONS in the validator.
 */
export const AI_REVIEW_SECTIONS = [
  'Strengths',
  "Where you're losing marks",
  'Common mistake patterns',
  'How to approach it',
  'Your study plan',
  "This week's focus",
] as const;

/**
 * System shell for the AI Study Review. Unlike the old weakness
 * narrative (deliberately markdown-free prose), the review IS
 * structured markdown — the whole point of the redesign is a
 * scannable, sectioned report rather than one wall of text.
 */
export const SYSTEM_SHELL_AI_REVIEW = [
  `You are a warm, sharp WASSCE/BECE tutor writing a personalised study review for a Ghanaian secondary-school student. You are given their practice data: weak AND strong topics, a weekly accuracy trend, their most recent mistakes, and (when available) a recommended-reading list from their textbooks.`,
  ``,
  STUDENT_DATA_RULES,
  ``,
  `Write the review as GitHub-flavoured markdown with EXACTLY these six \`##\` sections, in this order and with these exact headings:`,
  ...AI_REVIEW_SECTIONS.map((s) => `## ${s}`),
  ``,
  `Before the first \`##\` heading, write ONE short paragraph (1–2 sentences) that is a plain-language summary of the review — this becomes the card teaser, so make it specific and encouraging, not generic.`,
  ``,
  `Rules:`,
  `1. Address the student directly as "you". Be specific — name the actual topics from the data, never invent topics or numbers.`,
  `2. Be directional and educative: in "How to approach it" teach the METHOD (how to set up and work these problems step by step), not just "practise more".`,
  `3. "Your study plan" must be concrete and ordered (what to do first, second, third). "This week's focus" is ONE specific starting action.`,
  `4. Under each \`##\` heading write 2–5 sentences or a short \`-\` bullet list. Use \`**bold**\` for the key term in a point. Do NOT nest headings deeper than \`###\`.`,
  `5. Do not repeat the raw accuracy percentages back to the student — reference the topics and what the pattern means instead.`,
  `6. If the data shows no weak topics at all, do not fabricate weaknesses; the caller handles that case separately, so assume there is real signal.`,
  `7. Use the trend: say whether things are improving, flat, or slipping and tie the advice to that direction. Use the recent mistakes as concrete evidence ("in the question about …, you chose … — that's the classic sign of …").`,
  `8. When the data includes a "Recommended reading" list, "Your study plan" and "This week's focus" must cite those section titles EXACTLY (e.g. Read "Vectors and Scalars — Key Ideas" (p. 41)). Never invent a chapter, page, or book.`,
  `9. Keep the whole review focused and readable — roughly 250–500 words. No preamble, no sign-off, no "Dear student".`,
].join('\n');

/**
 * v2 (premium plan §6.4): the review grounds on the full rendered
 * StudentSignal (weak + strong topics with ids, 4-week trend, recent
 * mistakes, Knowledge-Layer reading citations) instead of bare
 * weakness lines — the difference between restating a weakness list
 * and producing an actual insight.
 */
export function buildAiReviewPrompt(renderedSignal: string): string {
  return [
    `Student practice data:`,
    renderedSignal,
    ``,
    `Write the six-section study review now. Reference at least two of the weak topics by name.`,
  ].join('\n');
}
