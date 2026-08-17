/**
 * The structured shape Claude must return when extracting one NaCCA
 * sub-strand from the curriculum PDF. Mirrors the hierarchy in the plan
 * (§A3) and the entities: one sub-strand carries its Learning Outcomes
 * (Table A) and its Content Standards → Indicators → Assessment items
 * (Table B), joined by the shared code prefix.
 *
 * Extraction is segmented per sub-strand (NOT per page) because the
 * source's table cells span multiple pages — a whole sub-strand is fed
 * at once so the model can reassemble spanned cells.
 */

export interface ExtractedAssessmentItem {
  /** e.g. `1.1.1.AS.1` */
  code: string;
  /** Depth-of-Knowledge level 1–4. */
  dokLevel: number;
  /** The sample question (LaTeX preserved). */
  question: string;
  /** Worked solution if the curriculum supplies one. */
  solution?: string | null;
}

export interface ExtractedIndicator {
  /** e.g. `1.1.1.LI.1` — the atomic unit. */
  code: string;
  statement: string;
  /** Worked Examples + Solutions (LaTeX). Groundable knowledge only. */
  workedContent?: string | null;
  assessmentItems?: ExtractedAssessmentItem[];
}

export interface ExtractedContentStandard {
  /** e.g. `1.1.1.CS.1` */
  code: string;
  statement: string;
  indicators: ExtractedIndicator[];
}

export interface ExtractedLearningOutcome {
  /** e.g. `1.1.1.LO.1` */
  code: string;
  statement: string;
}

/** Boilerplate columns — deduped into pedagogy_refs, never embedded. */
export interface ExtractedPedagogyRef {
  competencies?: string | null;
  gesiSelValues?: string | null;
}

/** One sub-strand's worth of extracted structure. */
export interface ExtractedSubStrand {
  /** Year 1–3. */
  formLevel: number;
  strand: { code: string; title: string };
  subStrand: { code: string; title: string };
  learningOutcomes: ExtractedLearningOutcome[];
  contentStandards: ExtractedContentStandard[];
  pedagogyRef?: ExtractedPedagogyRef | null;
}
