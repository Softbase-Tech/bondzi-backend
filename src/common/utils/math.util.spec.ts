import { inlineMathInMarkdown, markdownToHtml } from './math.util';
import { sanitizeHtml } from './sanitize.util';

describe('math pipeline smoke test', () => {
  it('renders the screenshot question end-to-end', () => {
    const body = 'Simplify $\\dfrac{5^7 \\times 5^4}{5^2}$';
    const m = inlineMathInMarkdown(body);
    expect(m).toMatch(/Simplify !\[math\]\(data:image\/svg\+xml;base64,/);
    expect(m.length).toBeGreaterThan(200);

    const html = sanitizeHtml(markdownToHtml(body));
    expect(html).toMatch(/katex/);
    expect(html).not.toContain('<script');

    const opts = ['$5^7$', '$5^8$', '$5^9$', '$5^{13}$'];
    for (const o of opts) {
      const md = inlineMathInMarkdown(o);
      expect(md).toMatch(/^!\[math\]\(data:image\/svg\+xml;base64,/);
    }
  });

  it('decoded SVG is well-formed for the screenshot expression', () => {
    const m = inlineMathInMarkdown('$\\dfrac{5^7 \\times 5^4}{5^2}$');
    const match = m.match(/data:image\/svg\+xml;base64,([^)]+)/);
    expect(match).not.toBeNull();
    const svg = Buffer.from(match![1], 'base64').toString('utf8');
    expect(svg).toMatch(/^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toMatch(/<\/svg>$/);
    // Sanity: the rendered SVG actually contains glyph paths.
    expect(svg).toMatch(/<path/);
  });

  it('plain text passes through untouched', () => {
    expect(inlineMathInMarkdown('A tank contains 400 litres')).toBe(
      'A tank contains 400 litres',
    );
  });
});
