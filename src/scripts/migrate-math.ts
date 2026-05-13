/**
 * One-shot migration: normalise legacy math content to LaTeX and re-render
 * `body_html` using the new pipeline.
 *
 * The historical bulk past-paper imports stored math as Unicode glyphs
 * (5⁷, ½, √x) or as ASCII (5^7) because there was no rendering pipeline.
 * Going forward, every save runs through markdownToHtml() with KaTeX, so we
 * back-convert the legacy rows once and let the new save path keep them in
 * sync from now on.
 *
 * Run: `npm run migrate:math` (or
 *   `npx ts-node -r tsconfig-paths/register src/scripts/migrate-math.ts`).
 *
 * Idempotent — safe to run repeatedly. Does not touch rows whose `body`
 * already contains `$`-delimited LaTeX (assumed to have been authored or
 * migrated previously).
 */
import 'dotenv/config';
import 'reflect-metadata';
import dataSource from '../../ormconfig';
import { Question } from '../modules/questions/entities/question.entity';
import { Option } from '../modules/questions/entities/option.entity';
import { sanitizeHtml } from '../common/utils/sanitize.util';
import { markdownToHtml } from '../common/utils/math.util';

// Map: legacy glyph → LaTeX equivalent.
const SUPERSCRIPTS: Record<string, string> = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
  '⁺': '+',
  '⁻': '-',
  '⁼': '=',
  '⁽': '(',
  '⁾': ')',
  ⁿ: 'n',
};
const SUBSCRIPTS: Record<string, string> = {
  '₀': '0',
  '₁': '1',
  '₂': '2',
  '₃': '3',
  '₄': '4',
  '₅': '5',
  '₆': '6',
  '₇': '7',
  '₈': '8',
  '₉': '9',
};
const FRACTIONS: Record<string, string> = {
  '½': '\\frac{1}{2}',
  '⅓': '\\frac{1}{3}',
  '⅔': '\\frac{2}{3}',
  '¼': '\\frac{1}{4}',
  '¾': '\\frac{3}{4}',
  '⅕': '\\frac{1}{5}',
  '⅖': '\\frac{2}{5}',
  '⅗': '\\frac{3}{5}',
  '⅘': '\\frac{4}{5}',
  '⅙': '\\frac{1}{6}',
  '⅚': '\\frac{5}{6}',
  '⅛': '\\frac{1}{8}',
  '⅜': '\\frac{3}{8}',
  '⅝': '\\frac{5}{8}',
  '⅞': '\\frac{7}{8}',
};
const SYMBOLS: Record<string, string> = {
  '×': '\\times ',
  '÷': '\\div ',
  '±': '\\pm ',
  '≤': '\\leq ',
  '≥': '\\geq ',
  '≠': '\\neq ',
  '√': '\\sqrt',
  π: '\\pi ',
  '∞': '\\infty ',
  θ: '\\theta ',
  α: '\\alpha ',
  β: '\\beta ',
};

function convertUnicodeToLatex(text: string): string {
  if (!text) return text;
  // Skip rows that are already authored in LaTeX — assume the admin or a
  // prior pass got there first.
  if (/\$[^\n$]+\$/.test(text)) return text;

  let out = text;

  // Whole fractions: just substitute the LaTeX form, dollar-wrapped.
  for (const [glyph, latex] of Object.entries(FRACTIONS)) {
    out = out.split(glyph).join(`$${latex}$`);
  }

  // Run lengths of superscripts: e.g. `5⁷⁸` → `5^{78}` → wrap in `$…$`.
  out = out.replace(/([A-Za-z0-9])([⁰-⁹⁺⁻⁼⁽⁾ⁿ]+)/g, (_, base, run: string) => {
    const inner = [...run].map((c) => SUPERSCRIPTS[c] ?? c).join('');
    return inner.length === 1 ? `$${base}^${inner}$` : `$${base}^{${inner}}$`;
  });
  out = out.replace(/([A-Za-z0-9])([₀-₉]+)/g, (_, base, run: string) => {
    const inner = [...run].map((c) => SUBSCRIPTS[c] ?? c).join('');
    return inner.length === 1 ? `$${base}_${inner}$` : `$${base}_{${inner}}$`;
  });

  // Bare ASCII like `5^7` → `$5^7$`. Only fires outside an existing `$…$`.
  out = out.replace(/([A-Za-z0-9])\^([A-Za-z0-9]|\{[^}]+\})/g, (m) => {
    return `$${m}$`;
  });

  // Stand-alone symbols (×, ÷, etc.) inside math segments would already
  // have been wrapped above; outside math, leave them as Unicode — they
  // render fine in plain text and Markdown.
  // (Intentionally not converting here to avoid double-wrapping.)
  void SYMBOLS;

  // Coalesce immediately adjacent `$…$$…$` pairs → `$…  …$` so the
  // downstream renderer sees one expression rather than two.
  out = out.replace(/\$\s*\$/g, ' ');

  return out;
}

interface Stats {
  questions: { scanned: number; rewritten: number };
  options: { scanned: number; rewritten: number };
}

async function migrate(): Promise<Stats> {
  const stats: Stats = {
    questions: { scanned: 0, rewritten: 0 },
    options: { scanned: 0, rewritten: 0 },
  };

  const qRepo = dataSource.getRepository(Question);
  const oRepo = dataSource.getRepository(Option);

  const PAGE = 200;
  let offset = 0;
  while (true) {
    const batch = await qRepo
      .createQueryBuilder('q')
      .orderBy('q.created_at', 'ASC')
      .skip(offset)
      .take(PAGE)
      .getMany();
    if (batch.length === 0) break;
    offset += batch.length;

    for (const q of batch) {
      stats.questions.scanned += 1;
      const newBody = convertUnicodeToLatex(q.body);
      const newHtml = sanitizeHtml(markdownToHtml(newBody));
      if (newBody !== q.body || newHtml !== q.bodyHtml) {
        q.body = newBody;
        q.bodyHtml = newHtml;
        await qRepo.save(q);
        stats.questions.rewritten += 1;
      }
    }
    process.stdout.write(
      `[migrate-math] questions scanned=${stats.questions.scanned} rewritten=${stats.questions.rewritten}\r`,
    );
  }
  process.stdout.write('\n');

  offset = 0;
  while (true) {
    const batch = await oRepo
      .createQueryBuilder('o')
      .orderBy('o.id', 'ASC')
      .skip(offset)
      .take(PAGE)
      .getMany();
    if (batch.length === 0) break;
    offset += batch.length;

    for (const o of batch) {
      stats.options.scanned += 1;
      const newBody = convertUnicodeToLatex(o.body);
      const newHtml = sanitizeHtml(markdownToHtml(newBody));
      if (newBody !== o.body || newHtml !== o.bodyHtml) {
        o.body = newBody;
        o.bodyHtml = newHtml;
        await oRepo.save(o);
        stats.options.rewritten += 1;
      }
    }
    process.stdout.write(
      `[migrate-math] options scanned=${stats.options.scanned} rewritten=${stats.options.rewritten}\r`,
    );
  }
  process.stdout.write('\n');

  return stats;
}

async function main() {
  await dataSource.initialize();
  console.log('[migrate-math] starting');
  const stats = await migrate();
  console.log('[migrate-math] done', JSON.stringify(stats, null, 2));
  await dataSource.destroy();
}

main().catch((err) => {
  console.error('[migrate-math] failed', err);
  process.exit(1);
});

// Exported for unit tests in src/scripts/__tests__.
export { convertUnicodeToLatex };
