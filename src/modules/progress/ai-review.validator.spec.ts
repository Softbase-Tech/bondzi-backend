import { validateAiReview } from './ai-review.validator';
import { AI_REVIEW_SECTIONS } from './ai-review.prompt';

// A well-formed review: a lead paragraph then all six sections in order,
// comfortably over the length floor.
const LEAD =
  'You are close to a real breakthrough in Physics — your setup is sound, and tightening two habits will move your scores fast.';

function body(): string {
  const sections = AI_REVIEW_SECTIONS.map(
    (s) =>
      `## ${s}\n\nThis is a meaningful paragraph about ${s} that carries enough substance to read like a genuine section of the report and not a one-line stub.`,
  ).join('\n\n');
  return `${LEAD}\n\n${sections}`;
}

describe('validateAiReview', () => {
  it('accepts a well-formed six-section review and extracts the lead as summary', () => {
    const result = validateAiReview(body());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toBe(LEAD);
    expect(result.summary).not.toContain('#');
  });

  it('accepts ### heading levels as well as ##', () => {
    const deeper = body().replace(/^## /gm, '### ');
    const result = validateAiReview(deeper);
    expect(result.ok).toBe(true);
  });

  it('surfaces the JSON refusal shape as model_refused', () => {
    const result = validateAiReview(
      JSON.stringify({ error: 'out_of_scope', detail: 'no signal' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('model_refused');
    expect(result.detail).toContain('no signal');
  });

  it('rejects too-short output', () => {
    const result = validateAiReview('## Strengths\ngood.');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too_short');
  });

  it('rejects when a required section is missing', () => {
    const missing = body().replace(
      `## ${AI_REVIEW_SECTIONS[3]}`,
      '## Something Else',
    );
    const result = validateAiReview(missing);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_sections');
  });

  it('rejects when sections appear out of order', () => {
    // Swap the first two headings so "Where you're losing marks" precedes
    // "Strengths".
    const swapped = body()
      .replace(`## ${AI_REVIEW_SECTIONS[0]}`, '@@FIRST@@')
      .replace(`## ${AI_REVIEW_SECTIONS[1]}`, `## ${AI_REVIEW_SECTIONS[0]}`)
      .replace('@@FIRST@@', `## ${AI_REVIEW_SECTIONS[1]}`);
    const result = validateAiReview(swapped);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('section_order_wrong');
  });

  it('falls back to the first section line when there is no lead paragraph', () => {
    const noLead = body().slice(body().indexOf('## '));
    const result = validateAiReview(noLead);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.summary).not.toMatch(/^#/);
  });
});
