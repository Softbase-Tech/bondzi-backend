/**
 * Content-based detection for "this MCQ is calculation-shaped and its
 * explanation needs a step-by-step Solution + a Worked Example on a
 * different problem, regardless of subject."
 *
 * The subject-level `isQuantitativeSubject` allowlist is a strong
 * default (Physics / Chemistry / Maths / Additional Maths / …), but
 * it misses:
 *   - a numeric Economics question ("If demand rises by 20% …")
 *   - a titration item in Biology
 *   - any newly-added subject that isn't in the allowlist
 *
 * This heuristic reads the actual stem + options. Any positive signal
 * on either side is enough — false positives here are cheap (an extra
 * paragraph in the explanation) and false negatives are the whole
 * problem we're fixing.
 *
 * Signals:
 *   • Imperative keywords: solve, calculate, compute, find, evaluate,
 *     determine, work out, express, simplify, round, prove.
 *   • LaTeX math markers (`$…$`) in the stem or any option.
 *   • Equation / operator patterns (=, +, −, ×, ÷, /, ^, fraction,
 *     sqrt, integral).
 *   • Numeric answer options — three or four options that are
 *     primarily numeric (with optional units, decimal points,
 *     scientific notation, currency).
 *   • Unit-carrying options (N, m/s, kg, °C, mol, GH₵, %, …).
 */

const CALC_KEYWORDS = new RegExp(
  [
    '\\b(solve|calculate|calc|compute|find|evaluate|determine|work out|',
    'express|simplify|round|approximate|prove|derive|integrate|',
    'differentiate|factorize|factorise|solve for|how many|what is the',
    ' value|percentage|the sum|the mean|the median|the mode|the ratio|',
    'the probability)\\b',
  ].join(''),
  'i',
);

// Any LaTeX inline math block. Same delimiter the mobile / admin
// renderer uses.
const LATEX_INLINE = /\$[^$]+\$/;

// Broad "there is arithmetic going on" pattern. Requires the
// operator to touch a digit — a bare hyphen in prose ("6-million-
// year-old", ranges like "1990-2000", compound adjectives) is not
// evidence of a calculation. `=` and `×`/`÷` are strong enough on
// their own; `+`, `-`, `/`, `^` need a digit next door.
const ARITHMETIC_OPERATORS =
  /[=×÷]|\d\s*[+\-*/^]\s*\d|\bsqrt\b|\\frac|\\sqrt|\\int|\\times|\\div/;

// A cell that's "mostly a number with maybe a unit". Threshold: at
// least one digit, and after stripping known formatting the digits +
// unit letters make up ≥ 50% of the option's characters.
const NUMERIC_OPTION = /\d/;
const UNIT_HINT = new RegExp(
  [
    '\\b(N|kg|g|m|s|Hz|W|V|A|Ω|J|Pa|°?C|°?F|K|mol|L|mL|cm|mm|km|',
    'ms|min|h|hr|yr|day|ha|km/h|m/s|m/s\\^?2|N/m|Nm|kJ|MJ|kW|MW|',
    'mA|µA|nA|kPa|MPa|GPa|dm|dm\\^?3|cm\\^?3|m\\^?3|mol/L|mol/dm\\^?3)\\b',
  ].join(''),
  'i',
);
const CURRENCY_HINT = /\b(GH₵|GH\$|GHC|GHS|USD|\$|£|€)\s?\d/i;

function looksNumeric(cell: string): boolean {
  const trimmed = cell.trim();
  if (!trimmed) return false;
  if (!NUMERIC_OPTION.test(trimmed)) return false;
  if (LATEX_INLINE.test(trimmed)) return true;
  if (UNIT_HINT.test(trimmed)) return true;
  if (CURRENCY_HINT.test(trimmed)) return true;
  // Percentage / plain decimal / scientific notation with mostly
  // digits — accept if ≥ half the chars are digits or math-formatting.
  const digitCount = (trimmed.match(/[0-9.,%\-+()×xX·^*/]/g) ?? []).length;
  return digitCount / trimmed.length >= 0.5;
}

export interface CalcDetectionInput {
  stem: string;
  options?: Array<{ body?: string | null } | null | undefined>;
}

/**
 * Returns true when the question looks calculation-shaped.
 * Order of checks is cheapest-first so easy positives short-circuit.
 */
export function looksLikeCalcQuestion(input: CalcDetectionInput): boolean {
  const stem = input.stem ?? '';
  if (!stem) return false;

  if (CALC_KEYWORDS.test(stem)) return true;
  if (LATEX_INLINE.test(stem)) return true;
  if (ARITHMETIC_OPERATORS.test(stem)) return true;

  const options = (input.options ?? []).filter(
    (o): o is { body?: string | null } => Boolean(o),
  );
  const optionBodies = options
    .map((o) => (typeof o.body === 'string' ? o.body : ''))
    .filter((b) => b.length > 0);

  // Any single option that's LaTeX / carries a unit / has currency.
  if (optionBodies.some((b) => LATEX_INLINE.test(b))) return true;
  if (optionBodies.some((b) => UNIT_HINT.test(b))) return true;
  if (optionBodies.some((b) => CURRENCY_HINT.test(b))) return true;

  // At least three of the four options look numeric — a classic
  // "pick the right number" MCQ shape.
  const numericCount = optionBodies.filter(looksNumeric).length;
  if (numericCount >= 3) return true;

  return false;
}
