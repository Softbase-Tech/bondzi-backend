import { ExtractedSubStrand } from './syllabus-extraction.types';

/**
 * Validates the JSON Claude returns for one sub-strand extraction
 * BEFORE it is written to the hierarchy tables. Never throws — the job
 * inspects the result and logs a reject rather than crashing the batch.
 *
 * Checks: refusal shape; parseable JSON; required skeleton present
 * (strand/sub-strand codes + titles, form level, at least one content
 * standard, each with a code + statement + ≥1 indicator with a code +
 * statement). Assessment items are normalised (dokLevel clamped to 1–4).
 */

export type SyllabusExtractionRejectReason =
  | 'model_refused'
  | 'not_json'
  | 'missing_strand'
  | 'missing_sub_strand'
  | 'no_content_standards'
  | 'malformed_indicator';

export type SyllabusExtractionResult =
  | { ok: true; value: ExtractedSubStrand }
  | { ok: false; reason: SyllabusExtractionRejectReason; detail: string };

function stripFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export function validateSyllabusExtraction(
  rawText: string,
): SyllabusExtractionResult {
  const trimmed = stripFences(rawText);

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      ok: false,
      reason: 'not_json',
      detail: 'output was not valid JSON',
    };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return {
      ok: false,
      reason: 'not_json',
      detail: 'output was not a JSON object',
    };
  }
  const obj = parsed as Record<string, unknown>;

  // Refusal shape.
  if (isNonEmptyString(obj.error)) {
    return {
      ok: false,
      reason: 'model_refused',
      detail: isNonEmptyString(obj.detail) ? obj.detail : obj.error,
    };
  }

  const strand = obj.strand as Record<string, unknown> | undefined;
  if (
    !strand ||
    !isNonEmptyString(strand.code) ||
    !isNonEmptyString(strand.title)
  ) {
    return {
      ok: false,
      reason: 'missing_strand',
      detail: 'strand.code/title missing',
    };
  }

  const subStrand = obj.subStrand as Record<string, unknown> | undefined;
  if (
    !subStrand ||
    !isNonEmptyString(subStrand.code) ||
    !isNonEmptyString(subStrand.title)
  ) {
    return {
      ok: false,
      reason: 'missing_sub_strand',
      detail: 'subStrand.code/title missing',
    };
  }

  const contentStandards = Array.isArray(obj.contentStandards)
    ? (obj.contentStandards as Array<Record<string, unknown>>)
    : [];
  if (contentStandards.length === 0) {
    return {
      ok: false,
      reason: 'no_content_standards',
      detail: 'at least one content standard is required',
    };
  }

  for (const cs of contentStandards) {
    if (!isNonEmptyString(cs.code) || !isNonEmptyString(cs.statement)) {
      return {
        ok: false,
        reason: 'malformed_indicator',
        detail: 'a content standard is missing code/statement',
      };
    }
    const indicators = Array.isArray(cs.indicators)
      ? (cs.indicators as Array<Record<string, unknown>>)
      : [];
    if (indicators.length === 0) {
      return {
        ok: false,
        reason: 'malformed_indicator',
        detail: `content standard ${String(cs.code)} has no indicators`,
      };
    }
    for (const ind of indicators) {
      if (!isNonEmptyString(ind.code) || !isNonEmptyString(ind.statement)) {
        return {
          ok: false,
          reason: 'malformed_indicator',
          detail: `an indicator under ${String(cs.code)} is missing code/statement`,
        };
      }
    }
  }

  const formLevel = Number(obj.formLevel);
  const value: ExtractedSubStrand = {
    formLevel: Number.isFinite(formLevel) ? formLevel : 0,
    strand: { code: String(strand.code), title: String(strand.title) },
    subStrand: { code: String(subStrand.code), title: String(subStrand.title) },
    learningOutcomes: (Array.isArray(obj.learningOutcomes)
      ? (obj.learningOutcomes as Array<Record<string, unknown>>)
      : []
    )
      .filter(
        (lo) => isNonEmptyString(lo.code) && isNonEmptyString(lo.statement),
      )
      .map((lo) => ({
        code: String(lo.code),
        statement: String(lo.statement),
      })),
    contentStandards: contentStandards.map((cs) => ({
      code: String(cs.code),
      statement: String(cs.statement),
      indicators: (cs.indicators as Array<Record<string, unknown>>).map(
        (ind) => ({
          code: String(ind.code),
          statement: String(ind.statement),
          workedContent: isNonEmptyString(ind.workedContent)
            ? String(ind.workedContent)
            : null,
          assessmentItems: (Array.isArray(ind.assessmentItems)
            ? (ind.assessmentItems as Array<Record<string, unknown>>)
            : []
          )
            .filter((ai) => isNonEmptyString(ai.question))
            .map((ai) => ({
              code: isNonEmptyString(ai.code) ? String(ai.code) : '',
              dokLevel: clampDok(Number(ai.dokLevel)),
              question: String(ai.question),
              solution: isNonEmptyString(ai.solution)
                ? String(ai.solution)
                : null,
            })),
        }),
      ),
    })),
    pedagogyRef: normalisePedagogy(obj.pedagogyRef),
  };

  return { ok: true, value };
}

function clampDok(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(4, Math.max(1, Math.round(n)));
}

function normalisePedagogy(raw: unknown): ExtractedSubStrand['pedagogyRef'] {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const competencies = isNonEmptyString(p.competencies)
    ? String(p.competencies)
    : null;
  const gesiSelValues = isNonEmptyString(p.gesiSelValues)
    ? String(p.gesiSelValues)
    : null;
  if (!competencies && !gesiSelValues) return null;
  return { competencies, gesiSelValues };
}
