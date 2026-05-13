/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Math rendering pipeline.
 *
 * The exam-prep content uses Markdown with LaTeX math (e.g. `Simplify
 * $\dfrac{5^7 \times 5^4}{5^2}$`). We pre-render once on save and cache the
 * results so:
 *
 *   - Web/admin gets sanitised HTML (KaTeX HTML output inside marked()).
 *   - Mobile gets plain Markdown with each `$...$` segment replaced by an
 *     `![](data:image/svg+xml;base64,...)` so the existing
 *     react-native-markdown-display renderer can show it via a custom image
 *     rule that knows how to draw SVG data URIs (see
 *     mobile/components/exam/QuestionCard.tsx).
 *
 * MathJax (mathjax-full) is used for SVG output because KaTeX has no native
 * SVG renderer. Initialisation happens once at module load; renders are
 * memoised in an LRU keyed by the LaTeX source.
 */
import { LRUCache } from 'lru-cache';
import MarkdownIt from 'markdown-it';
import katex from 'katex';
// MathJax components — JS imports are CJS but the package ships its own
// types under `mathjax-full/js/...`. Import paths are stable across 3.x.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { mathjax } =
  require('mathjax-full/js/mathjax.js') as typeof import('mathjax-full/js/mathjax');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TeX } =
  require('mathjax-full/js/input/tex.js') as typeof import('mathjax-full/js/input/tex');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SVG } =
  require('mathjax-full/js/output/svg.js') as typeof import('mathjax-full/js/output/svg');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { liteAdaptor } =
  require('mathjax-full/js/adaptors/liteAdaptor.js') as typeof import('mathjax-full/js/adaptors/liteAdaptor');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RegisterHTMLHandler } =
  require('mathjax-full/js/handlers/html.js') as typeof import('mathjax-full/js/handlers/html');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AllPackages } =
  require('mathjax-full/js/input/tex/AllPackages.js') as typeof import('mathjax-full/js/input/tex/AllPackages');

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

// `noerrors` and `noundefined` keep MathJax from throwing on student-typo
// LaTeX during admin entry — instead it renders red placeholder glyphs.
const tex = new TeX({
  packages: AllPackages.filter((p) => p !== 'bussproofs'),
  inlineMath: [['$', '$']],
  displayMath: [['$$', '$$']],
});
const svg = new SVG({
  fontCache: 'none', // inline glyph paths so each SVG is self-contained
  exFactor: 0.5,
});
const mjxDoc = mathjax.document('', { InputJax: tex, OutputJax: svg });

const svgCache = new LRUCache<string, string>({ max: 2000 });

// Single shared markdown renderer. `html: true` lets KaTeX HTML survive the
// markdown pass; sanitizeHtml() strips anything we don't whitelist.
const md = new MarkdownIt({ html: true, breaks: true, linkify: false });

/**
 * Render a LaTeX expression to a self-contained SVG string. Returns "" for
 * empty input. Errors render as a red placeholder rather than throwing —
 * this is student content; we never want a single broken expression to
 * reject the whole question save.
 */
export function renderMathToSvg(latex: string, displayMode = false): string {
  if (!latex || !latex.trim()) return '';
  const key = `${displayMode ? 'D' : 'I'}|${latex}`;
  const hit = svgCache.get(key);
  if (hit !== undefined) return hit;
  let out: string;
  try {
    const node = mjxDoc.convert(latex, { display: displayMode });
    // outerHTML wraps in <mjx-container>; the <svg> child is what we need.
    const html = adaptor.outerHTML(node);
    const match = html.match(/<svg[\s\S]*<\/svg>/);
    out = match ? match[0] : '';
  } catch (err) {
    out = renderErrorPlaceholderSvg(latex);
  }
  svgCache.set(key, out);
  return out;
}

function renderErrorPlaceholderSvg(latex: string): string {
  const safe = latex.replace(/[<>&]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;',
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="20" viewBox="0 0 120 20"><text x="0" y="14" fill="#dc2626" font-family="monospace" font-size="12">${safe}</text></svg>`;
}

function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

/**
 * Replace every `$...$` and `$$...$$` in a markdown string with an inline
 * data-URI SVG image. Result is still valid markdown — mobile renders it
 * via the standard image node + a custom SVG image rule.
 *
 * Order matters: we match `$$...$$` first so we don't fire `$...$` on the
 * empty space between two display-math delimiters.
 */
export function inlineMathInMarkdown(md: string): string {
  if (!md) return md;
  let out = md.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
    const svg = renderMathToSvg(String(tex), true);
    if (!svg) return '';
    return `\n\n![math](${svgToDataUri(svg)})\n\n`;
  });
  out = out.replace(/(?<!\\)\$([^\n$]+?)\$/g, (_, tex) => {
    const svg = renderMathToSvg(String(tex), false);
    if (!svg) return '';
    return `![math](${svgToDataUri(svg)})`;
  });
  return out;
}

/**
 * Replace `$...$` with KaTeX HTML output. Used as the math step inside
 * markdownToHtml — this is what populates `body_html`.
 */
function inlineMathToKatexHtml(md: string): string {
  if (!md) return md;
  let out = md.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
    try {
      return katex.renderToString(String(tex), {
        displayMode: true,
        throwOnError: false,
        output: 'html',
      });
    } catch {
      return `<span class="math-error">${escapeHtml(String(tex))}</span>`;
    }
  });
  out = out.replace(/(?<!\\)\$([^\n$]+?)\$/g, (_, tex) => {
    try {
      return katex.renderToString(String(tex), {
        displayMode: false,
        throwOnError: false,
        output: 'html',
      });
    } catch {
      return `<span class="math-error">${escapeHtml(String(tex))}</span>`;
    }
  });
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render a markdown source (with `$...$` math) to HTML for storage in
 * `body_html`. The output still needs to pass through sanitizeHtml() before
 * it touches the database. Order: math first (so KaTeX HTML survives
 * marked's HTML escaping), then markdown.
 */
export function markdownToHtml(source: string): string {
  if (!source) return source;
  // Math first — KaTeX HTML output contains spans we need to keep through
  // the markdown pass. sanitizeHtml() takes the final pass on what's safe.
  const withMath = inlineMathToKatexHtml(source);
  return md.render(withMath);
}
