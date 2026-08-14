import { validateExplanation } from './explanation.validator';

const STEM =
  'A car accelerates uniformly from 5 m/s to 25 m/s in 10 seconds. What is its acceleration?';

// A minimal explanation that satisfies every rule: two sections in
// the right order, above the length floor, does not repeat the stem.
const OK_MARKDOWN = `## Solution

The concept here is uniform acceleration. Acceleration a equals the
change in velocity divided by the time interval:

  a = (v_final - v_initial) / t

Substituting the known values: a = (25 - 5) / 10 = 2 m/s².

The correct answer is B (2 m/s²).
Option A (0.5 m/s²): forgets to compute the change in velocity.
Option C (20 m/s²): divides by 1 instead of by 10.
Option D (30 m/s²): sums velocities rather than subtracting.

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

  it('rejects too-short output', () => {
    const result = validateExplanation(
      '## Solution\nThe answer is B.\n## Example\nsame.',
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

  it('rejects when the Example heading is missing (extensive-example requirement)', () => {
    const noExample = OK_MARKDOWN.replace('## Example', 'Another try:');
    const result = validateExplanation(noExample, STEM);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_example_section');
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
    // clears the 400-char floor.
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
correct answer is B.`;
    const result = validateExplanation(swapped, STEM);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('section_order_wrong');
  });

  it('rejects when the output prefixes the question stem verbatim', () => {
    const parroted = `${STEM}\n\n${OK_MARKDOWN}`;
    const result = validateExplanation(parroted, STEM);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('stem_verbatim');
  });
});
