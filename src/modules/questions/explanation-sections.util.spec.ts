import { splitExplanationSections } from './explanation-sections.util';

describe('splitExplanationSections', () => {
  it('splits Solution and Worked Example sections', () => {
    const md = [
      '## Solution',
      'The correct answer is B because momentum is conserved.',
      '',
      '## Worked Example',
      'A 2 kg cart at 3 m/s hits a 1 kg cart...',
    ].join('\n');
    const { solution, workedExample } = splitExplanationSections(md);
    expect(solution).toBe(
      'The correct answer is B because momentum is conserved.',
    );
    expect(workedExample).toBe('A 2 kg cart at 3 m/s hits a 1 kg cart...');
  });

  it('recognises the legacy `## Example` heading', () => {
    const md = '## Solution\nBecause X.\n\n## Example\nHere is another one.';
    const { solution, workedExample } = splitExplanationSections(md);
    expect(solution).toBe('Because X.');
    expect(workedExample).toBe('Here is another one.');
  });

  it('returns null workedExample when there is no example section', () => {
    const md =
      '## Solution\nThe answer is C; A and B confuse mass with weight.';
    const { solution, workedExample } = splitExplanationSections(md);
    expect(solution).toBe('The answer is C; A and B confuse mass with weight.');
    expect(workedExample).toBeNull();
  });

  it('handles any heading level and case', () => {
    const md = '### solution\nBody.\n\n#### worked example\nExample body.';
    const { solution, workedExample } = splitExplanationSections(md);
    expect(solution).toBe('Body.');
    expect(workedExample).toBe('Example body.');
  });

  it('treats an empty example section as absent', () => {
    const md = '## Solution\nBody text here.\n\n## Worked Example\n   \n';
    const { solution, workedExample } = splitExplanationSections(md);
    expect(solution).toBe('Body text here.');
    expect(workedExample).toBeNull();
  });

  it('falls back to whole body as solution when no headings at all', () => {
    const md = 'Just a plain paragraph explanation with no headings.';
    const { solution, workedExample } = splitExplanationSections(md);
    expect(solution).toBe(
      'Just a plain paragraph explanation with no headings.',
    );
    expect(workedExample).toBeNull();
  });

  it('does not match "Example" inside a paragraph', () => {
    const md =
      '## Solution\nFor example, consider the following reasoning about B.';
    const { solution, workedExample } = splitExplanationSections(md);
    expect(workedExample).toBeNull();
    expect(solution).toContain('For example');
  });

  it('handles empty / null input', () => {
    expect(splitExplanationSections('')).toEqual({
      solution: '',
      workedExample: null,
    });
    expect(splitExplanationSections(null)).toEqual({
      solution: '',
      workedExample: null,
    });
  });
});
