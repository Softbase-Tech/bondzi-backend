/**
 * Detects whether a subject is quantitative — questions in these
 * subjects predominantly involve calculations, formulae, or
 * step-by-step numeric procedures. For these subjects the AI
 * explanation MUST include both a `## Solution` (step-by-step
 * derivation) AND a `## Worked Example` (a similar-but-different
 * problem, so the student learns the METHOD, not just the answer
 * to this one item).
 *
 * Allowlist by common WAEC / NaCCA subject names, matched
 * case-insensitively on the trimmed subject name (or code). Kept as
 * a pure util so the same detection fires at question-generation
 * time, single-question regeneration time, and explanation-batch
 * time.
 */
const QUANTITATIVE_NAMES: readonly string[] = [
  // Sciences
  'physics',
  'chemistry',
  'biology', // biology has quantitative genetics / titration questions
  'general science',
  'integrated science',
  // Maths family
  'mathematics',
  'core mathematics',
  'general mathematics',
  'additional mathematics',
  'elective mathematics',
  'further mathematics',
  // Commercial + social
  'accounting',
  'financial accounting',
  'principles of cost accounting',
  'economics',
  'statistics',
  'business mathematics',
];

const QUANTITATIVE_CODES: readonly string[] = [
  'PHY',
  'CHEM',
  'BIO',
  'GENSCI',
  'INTSCI',
  'MATH',
  'CMATH',
  'GMATH',
  'AMATH',
  'EMATH',
  'FMATH',
  'ACCT',
  'FIACC',
  'PCA',
  'ECON',
  'STAT',
  'BMATH',
];

/**
 * True when the given subject is quantitative and its questions
 * routinely require step-by-step working. Accepts either the
 * display name (e.g. "Additional Mathematics") or the internal
 * code (e.g. "AMATH") — code comparison is exact, name comparison
 * is case-insensitive on the trimmed value.
 */
export function isQuantitativeSubject(subject?: {
  name?: string | null;
  code?: string | null;
}): boolean {
  if (!subject) return false;
  const name = subject.name?.trim().toLowerCase() ?? '';
  if (name && QUANTITATIVE_NAMES.includes(name)) return true;
  const code = subject.code?.trim().toUpperCase() ?? '';
  if (code && QUANTITATIVE_CODES.includes(code)) return true;
  return false;
}
