import { DataSource } from 'typeorm';
import { PromptTemplate } from '../../modules/ai/entities/prompt-template.entity';

/**
 * v2 prompt templates — seeded into prompt_templates. The workers in
 * `jobs/ai-generation.processor.ts` build their final prompts inline so these
 * rows are a source of truth for the admin dashboard ("what prompt will the
 * next run use?") and can be A/B-swapped by admins later without a deploy.
 */

export const EXPLANATION_PROMPT_NAME = 'EXPLANATION';
export const EXPLANATION_PROMPT_VERSION = 'v3';

export const EXPLANATION_PROMPT_V3 = `You are a patient, encouraging tutor helping a Ghanaian
{schoolLevel} student (Form {formLevel}) prepare for their {examType} examination.

Question ({subjectName}):
{questionBody}

Options:
A. {optionA}  B. {optionB}  C. {optionC}  D. {optionD}

Correct answer: {correctLabel}. {correctBody}

Write a clear explanation (maximum 150 words) that:
1. States why the correct answer is right, simply and directly.
2. Explains why the wrong options are incorrect.
3. Uses language appropriate for Form {formLevel} {schoolLevel} level.

Write in plain paragraphs. No bullet points. No headers.
Do not mention 'WAEC' or 'exam'. Address the student directly.

When mathematical notation is needed, write it as LaTeX inside dollar
delimiters — inline math uses single dollars (e.g. $5^7$, $\\dfrac{a}{b}$,
$\\sqrt{x^2 + y^2}$), block math uses double dollars. Never use Unicode
superscripts (5⁷), Unicode fractions (½), or ASCII art for math; the
renderer needs the LaTeX form so it can display crisp glyphs.`;

// Kept exported under the old name so any worker still importing
// EXPLANATION_PROMPT_V2 keeps compiling — points at the v3 content.
export const EXPLANATION_PROMPT_V2 = EXPLANATION_PROMPT_V3;

export const PM_TEST_PROMPT_NAME = 'PM_TEST_GENERATION';
export const PM_TEST_PROMPT_VERSION = 'v1';

export const PM_TEST_PROMPT_V1 = `You are an expert {examType} exam question writer for Ghanaian students.
You create high-quality {difficulty} multiple-choice questions for {subjectName}
at {formLevel} level ({schoolLevel}).

Generate exactly {count} unique MCQ questions on the topic: {topicTitle}.
Each question must:
- Be answerable by a {formLevel} {schoolLevel} student in Ghana
- Follow WAEC question format and style
- Have exactly 4 options (A, B, C, D)
- Have exactly one correct answer
- Include a concise explanation (2-3 sentences) of why the answer is correct

Math formatting: write all mathematical notation as LaTeX inside dollar
delimiters (e.g. $5^7$, $\\dfrac{a}{b}$, $\\sqrt{x}$). Do NOT use Unicode
superscripts (5⁷), Unicode fractions, or ASCII art — the renderer requires
LaTeX. Inside JSON, escape backslashes as \\\\ so $\\dfrac{a}{b}$ becomes
"$\\\\dfrac{a}{b}$".

Return ONLY a valid JSON array. No preamble. No markdown fences. No commentary.
Format: [{"body":"...","options":[{"label":"...","body":"...","isCorrect":true}],"explanation":"...","difficulty":"..."}]`;

export const HINT_PROMPT_NAME = 'HINT';
export const HINT_PROMPT_VERSION = 'v1';

export const HINT_PROMPT_V1 = `You are helping a Ghanaian secondary school student who is stuck on a question.
Give ONE small nudge — not the full answer.

SUBJECT: {subject}
QUESTION: {questionBody}

Respond with a single sentence under 40 words pointing the student toward the
right approach without revealing the answer.`;

export async function seedPrompts(ds: DataSource): Promise<void> {
  const repo = ds.getRepository(PromptTemplate);
  const templates: Partial<PromptTemplate>[] = [
    {
      name: EXPLANATION_PROMPT_NAME,
      version: EXPLANATION_PROMPT_VERSION,
      content: EXPLANATION_PROMPT_V3,
      isActive: true,
    },
    {
      name: PM_TEST_PROMPT_NAME,
      version: PM_TEST_PROMPT_VERSION,
      content: PM_TEST_PROMPT_V1,
      isActive: true,
    },
    {
      name: HINT_PROMPT_NAME,
      version: HINT_PROMPT_VERSION,
      content: HINT_PROMPT_V1,
      isActive: true,
    },
  ];
  for (const t of templates) {
    const existing = await repo.findOne({
      where: { name: t.name, version: t.version },
    });
    if (existing) {
      await repo.update(existing.id, { content: t.content, isActive: true });
    } else {
      // Deactivate older active row for this name first
      await repo.update({ name: t.name, isActive: true }, { isActive: false });
      await repo.insert(repo.create(t));
    }
  }
}
