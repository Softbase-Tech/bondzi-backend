import { PastPaperWeakTopic, SyllabusWeakTopic } from './weakness.service';

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
  `You are a warm, sharp WASSCE/BECE tutor writing a personalised study review for a Ghanaian secondary-school student. You are given their weakest topics (with accuracy) from real practice.`,
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
  `7. Keep the whole review focused and readable — roughly 250–500 words. No preamble, no sign-off, no "Dear student".`,
].join('\n');

/**
 * Build the user prompt from the weakness rollup. Strengths are
 * inferred by the model from the relative ordering, but we also pass
 * the strongest-of-the-weak so it has something concrete to praise
 * rather than inventing a strength.
 */
export function buildAiReviewPrompt(
  past: PastPaperWeakTopic[],
  syllabus: SyllabusWeakTopic[],
): string {
  const line = (t: {
    title: string;
    subjectName: string;
    correct: number;
    answered: number;
  }) => `- ${t.title} (${t.subjectName}): ${t.correct}/${t.answered} correct`;

  const pastList = past.map(line).join('\n');
  const syllabusList = syllabus.map(line).join('\n');

  return [
    `Student practice data (weakest topics first):`,
    pastList ? `\nPast-paper topics they struggle with:\n${pastList}` : '',
    syllabusList
      ? `\nSyllabus (level-test) topics they struggle with:\n${syllabusList}`
      : '',
    `\nWrite the six-section study review now. Reference at least two of the topics above by name.`,
  ]
    .filter(Boolean)
    .join('\n');
}
