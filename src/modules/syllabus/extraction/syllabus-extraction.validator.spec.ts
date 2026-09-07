import { validateSyllabusExtraction } from './syllabus-extraction.validator';

// A well-formed one-sub-strand extraction based on the real Additional
// Maths sample (Strand 1 → Sub-strand 1.1 → CS 1.1.1.CS.1 → LI 1.1.1.LI.1).
const OK = JSON.stringify({
  formLevel: 1,
  strand: { code: '1', title: 'Modelling with Algebra' },
  subStrand: { code: '1.1', title: 'Number and Algebraic Patterns' },
  learningOutcomes: [
    {
      code: '1.1.1.LO.1',
      statement: 'Solve problems involving binary operations.',
    },
  ],
  contentStandards: [
    {
      code: '1.1.1.CS.1',
      statement: 'Demonstrate knowledge of binary operations…',
      indicators: [
        {
          code: '1.1.1.LI.1',
          statement: 'Explain binary operations and apply the knowledge.',
          workedContent: 'Example: $a*b = a + b - 2ab$. Solution: …',
          assessmentItems: [
            {
              code: '1.1.1.AS.1',
              dokLevel: 1,
              question: 'Find $3*(-2)$',
              solution: null,
            },
            {
              code: '1.1.1.AS.1',
              dokLevel: 4,
              question: 'Six shirts, two trousers…',
            },
          ],
        },
      ],
    },
  ],
  pedagogyRef: { competencies: 'Communication: …', gesiSelValues: 'GESI: …' },
});

describe('validateSyllabusExtraction', () => {
  it('accepts a well-formed sub-strand and preserves codes + LaTeX', () => {
    const r = validateSyllabusExtraction(OK);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.strand.code).toBe('1');
    const ind = r.value.contentStandards[0].indicators[0];
    expect(ind.code).toBe('1.1.1.LI.1');
    expect(ind.workedContent).toContain('$a*b');
    expect(ind.assessmentItems).toHaveLength(2);
  });

  it('tolerates ```json fences around the object', () => {
    const r = validateSyllabusExtraction('```json\n' + OK + '\n```');
    expect(r.ok).toBe(true);
  });

  it('surfaces the refusal shape as model_refused', () => {
    const r = validateSyllabusExtraction(
      JSON.stringify({ error: 'unextractable', detail: 'not a sub-strand' }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('model_refused');
    expect(r.detail).toContain('sub-strand');
  });

  it('rejects non-JSON', () => {
    const r = validateSyllabusExtraction('here is your data: ...');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not_json');
  });

  it('rejects when there are no content standards', () => {
    const bad = JSON.parse(OK);
    bad.contentStandards = [];
    const r = validateSyllabusExtraction(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no_content_standards');
  });

  it('rejects an indicator missing its code', () => {
    const bad = JSON.parse(OK);
    delete bad.contentStandards[0].indicators[0].code;
    const r = validateSyllabusExtraction(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('malformed_indicator');
  });

  it('rejects an oversized CS statement (would break the topics index)', () => {
    const bad = JSON.parse(OK);
    bad.contentStandards[0].statement = 'x'.repeat(2001);
    const r = validateSyllabusExtraction(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('malformed_indicator');
    expect(r.detail).toContain('2000-char cap');
  });

  it('clamps out-of-range DoK levels into 1–4', () => {
    const bad = JSON.parse(OK);
    bad.contentStandards[0].indicators[0].assessmentItems = [
      { code: 'x', dokLevel: 9, question: 'q' },
      { code: 'y', dokLevel: 0, question: 'q2' },
    ];
    const r = validateSyllabusExtraction(JSON.stringify(bad));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const items = r.value.contentStandards[0].indicators[0].assessmentItems!;
    expect(items[0].dokLevel).toBe(4);
    expect(items[1].dokLevel).toBe(1);
  });
});
