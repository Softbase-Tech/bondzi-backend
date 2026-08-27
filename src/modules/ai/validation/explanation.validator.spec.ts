import { validateExplanation } from './explanation.validator';

const STEM =
  'A car accelerates uniformly from 5 m/s to 25 m/s in 10 seconds. What is its acceleration?';

// A minimal explanation that satisfies every rule: two sections in
// the right order, above the length floor, does not repeat the stem,
// quotes the correct option's TEXT (never a letter — labels are
// reassigned by the server-side shuffle).
const OK_MARKDOWN = `## Solution

The concept here is uniform acceleration. Acceleration a equals the
change in velocity divided by the time interval:

  a = (v_final - v_initial) / t

Substituting the known values: a = (25 - 5) / 10 = 2 m/s².

The correct answer is **2 m/s²**.
**0.5 m/s²** forgets to compute the change in velocity.
**20 m/s²** divides by 1 instead of by 10.
**30 m/s²** sums the velocities rather than subtracting them.

## Example

A cyclist speeds up from 3 m/s to 15 m/s in 4 seconds. Using the
same formula, a = (15 - 3) / 4 = 3 m/s². The same reasoning
applies — subtract initial velocity from final, then divide by
elapsed time.`;

describe('validateExplanation', () => {
  it('accepts a valid two-section explanation', () => {
    const result = validateExplanation(OK_MARKDOWN, STEM);
    expect(result.ok).toBe(true);
  });

  it('surfaces the JSON refusal shape as model_refused', () => {
    const result = validateExplanation(
      JSON.stringify({
        error: 'out_of_syllabus',
        detail: 'topic Q outside F1 syllabus',
      }),
      STEM,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('model_refused');
    expect(result.detail).toContain('outside');
  });

  it('surfaces a key_mismatch refusal as its own reason (remediation B1)', () => {
    const result = validateExplanation(
      JSON.stringify({
        error: 'key_mismatch',
        detail: 'independent solve gives 2 m/s², provided key marks 20 m/s²',
      }),
      STEM,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('key_mismatch');
    expect(result.detail).toContain('independent solve');
  });

  it('surfaces an ambiguous_question refusal as its own reason', () => {
    const result = validateExplanation(
      JSON.stringify({
        error: 'ambiguous_question',
        detail: 'two options are defensible',
      }),
      STEM,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ambiguous_question');
  });

  it('rejects too-short output', () => {
    const result = validateExplanation(
      '## Solution\nThe answer is right.\n## Example\nsame.',
      STEM,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too_short');
  });

  it('rejects when the Solution heading is missing', () => {
    // A version of OK_MARKDOWN with `## Solution` replaced by plain
    // paragraph text. Long enough to bypass the length gate so we
    // can isolate the section check.
    const noSolution = OK_MARKDOWN.replace('## Solution', 'Solution:');
    const result = validateExplanation(noSolution, STEM);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_solution_section');
  });

  it('accepts a solution-only explanation (worked example is optional)', () => {
    // Drop the example section entirely — a conceptual question does not
    // need one. Keep the solution long enough to clear the length floor.
    const solutionOnly = OK_MARKDOWN.slice(
      0,
      OK_MARKDOWN.indexOf('## Example'),
    ).trim();
    const result = validateExplanation(solutionOnly, STEM);
    expect(result.ok).toBe(true);
  });

  it('accepts the `## Worked Example` heading', () => {
    const worked = OK_MARKDOWN.replace('## Example', '## Worked Example');
    const result = validateExplanation(worked, STEM);
    expect(result.ok).toBe(true);
  });

  it('accepts deeper heading levels (### Solution / ### Example)', () => {
    const h3 = OK_MARKDOWN.replace('## Solution', '### Solution').replace(
      '## Example',
      '### Example',
    );
    const result = validateExplanation(h3, STEM);
    expect(result.ok).toBe(true);
  });

  it('rejects when Example appears before Solution', () => {
    // Swap section order — pad both sections so combined length
    // clears the length floor.
    const swapped = `## Example

A first cyclist speeds up from 3 m/s to 15 m/s in 4 seconds. Using
a = (v_f - v_i) / t we get a = (15 - 3) / 4 = 3 m/s². The reasoning
generalises: subtract initial velocity from final, then divide by
the elapsed time.

## Solution

The concept here is uniform acceleration. Acceleration a equals the
change in velocity divided by the time interval:

  a = (v_final - v_initial) / t

Substituting the known values: a = (25 - 5) / 10 = 2 m/s². The
correct answer is **2 m/s²**.`;
    const result = validateExplanation(swapped, STEM);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('section_order_wrong');
  });

  it('rejects headings other than Solution / Worked Example', () => {
    const extraHeading = `${OK_MARKDOWN}\n\n## Key Takeaways\n\nRemember the formula.`;
    const result = validateExplanation(extraHeading, STEM);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('forbidden_heading');
    expect(result.detail).toContain('Key Takeaways');
  });

  it('rejects option-letter references ("The correct answer is B")', () => {
    const withLabel = OK_MARKDOWN.replace(
      'The correct answer is **2 m/s²**.',
      'The correct answer is B (2 m/s²).',
    );
    const result = validateExplanation(withLabel, STEM);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('label_reference');
  });

  it('rejects when the correct option text is never quoted', () => {
    const result = validateExplanation(OK_MARKDOWN, STEM, {
      correctOptionText: '4 m/s²', // not present anywhere in the body
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_correct_answer_text');
  });

  it('accepts when the correct option text is quoted (normalised match)', () => {
    const result = validateExplanation(OK_MARKDOWN, STEM, {
      correctOptionText: '2 m/s²',
    });
    expect(result.ok).toBe(true);
  });

  it('skips the option-text check for very short answers (≤3 chars)', () => {
    const result = validateExplanation(OK_MARKDOWN, STEM, {
      correctOptionText: 'Na', // substring presence proves nothing
    });
    expect(result.ok).toBe(true);
  });

  it('rejects when the output prefixes the question stem verbatim', () => {
    const parroted = `${STEM}\n\n${OK_MARKDOWN}`;
    const result = validateExplanation(parroted, STEM);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('stem_verbatim');
  });
});
