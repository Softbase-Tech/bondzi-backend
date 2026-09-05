import {
  shuffleOptions,
  validateQuestionBatchSalvage,
  type ParsedQuestion,
} from './question.validator';

const item = (over: Partial<Record<string, unknown>> = {}) => ({
  body: 'What is the acceleration of a car going from 5 m/s to 25 m/s in 10 s?',
  difficulty: 'medium',
  options: [
    { label: 'A', body: '2 m/s²', isCorrect: true },
    { label: 'B', body: '0.5 m/s²', isCorrect: false },
    { label: 'C', body: '20 m/s²', isCorrect: false },
    { label: 'D', body: '30 m/s²', isCorrect: false },
  ],
  explanation: '',
  ...over,
});

describe('validateQuestionBatchSalvage (remediation 0.5)', () => {
  it('keeps good items and rejects bad ones individually', () => {
    const raw = JSON.stringify([
      item(),
      item({ body: 'Water is?' }), // stem too short → rejected item
      item(),
    ]);
    const res = validateQuestionBatchSalvage(raw, { expectedCount: 3 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(2);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]).toMatchObject({
      index: 1,
      reason: 'stem_too_short',
    });
  });

  it('fails the whole batch on unparseable JSON', () => {
    const res = validateQuestionBatchSalvage('not json', {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('schema_invalid');
  });

  it('truncates overage beyond expectedCount with a warning', () => {
    const raw = JSON.stringify([item(), item(), item()]);
    const res = validateQuestionBatchSalvage(raw, { expectedCount: 2 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(2);
    expect(res.warnings.some((w) => w.includes('truncated'))).toBe(true);
  });

  it('the admin-requested difficulty overrides the model self-grade (with a warning)', () => {
    const raw = JSON.stringify([item({ difficulty: 'easy' })]);
    const res = validateQuestionBatchSalvage(raw, {
      requestedDifficulty: 'hard',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value[0].difficulty).toBe('hard');
    expect(res.value[0].warnings.some((w) => w.includes('self-graded'))).toBe(
      true,
    );
  });

  it('rejects a stem over 60 words', () => {
    const raw = JSON.stringify([
      item({ body: Array(61).fill('word').join(' ') + '?' }),
    ]);
    const res = validateQuestionBatchSalvage(raw, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rejected[0]?.reason).toBe('stem_too_long');
  });

  it('the bare-word syllabus ban is stem-only (explanations may discuss curricula as subject matter)', () => {
    const raw = JSON.stringify([
      item({
        body: 'Which reform placed Ghanaian basic schools under greater local community oversight?',
        options: [
          { label: 'A', body: 'The 2019 education reform', isCorrect: true },
          {
            label: 'B',
            body: 'The 1987 junior secondary rollout',
            isCorrect: false,
          },
          { label: 'C', body: 'The 1961 Education Act', isCorrect: false },
          {
            label: 'D',
            body: 'The 2007 four-year SHS change',
            isCorrect: false,
          },
        ],
        explanation:
          "## Solution\nGhana's school curriculum reform of 2019 introduced the standards-based approach, which is why **The 2019 education reform** is the correct answer here — the reform placed schools under local oversight.",
      }),
    ]);
    const res = validateQuestionBatchSalvage(raw, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rejected).toHaveLength(0);
  });

  it('rejects stems referencing a passage that does not exist (English trap)', () => {
    const raw = JSON.stringify([
      item({
        body: 'According to the passage, why did Kofi refuse to sell the family land?',
        options: [
          { label: 'A', body: 'It held his ancestors', isCorrect: true },
          { label: 'B', body: 'It was too small', isCorrect: false },
          { label: 'C', body: 'The price was low', isCorrect: false },
          { label: 'D', body: 'He feared the chief', isCorrect: false },
        ],
      }),
    ]);
    const res = validateQuestionBatchSalvage(raw, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rejected[0]?.reason).toBe('references_missing_stimulus');
  });

  it('rejects stems referencing a diagram that does not exist (Biology trap)', () => {
    const raw = JSON.stringify([
      item({
        body: 'In the diagram below, which labelled part of the flower produces pollen grains?',
        options: [
          { label: 'A', body: 'The anther structure', isCorrect: true },
          { label: 'B', body: 'The stigma surface', isCorrect: false },
          { label: 'C', body: 'The ovary wall', isCorrect: false },
          { label: 'D', body: 'The petal base', isCorrect: false },
        ],
      }),
    ]);
    const res = validateQuestionBatchSalvage(raw, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rejected[0]?.reason).toBe('references_missing_stimulus');
  });

  it('rejects a table reference with no inline table, accepts one WITH an inline table', () => {
    const noTable = JSON.stringify([
      item({
        body: 'From the table above, which town recorded the highest rainfall in June?',
        options: [
          { label: 'A', body: 'Kumasi town', isCorrect: true },
          { label: 'B', body: 'Tamale town', isCorrect: false },
          { label: 'C', body: 'Accra city', isCorrect: false },
          { label: 'D', body: 'Takoradi port', isCorrect: false },
        ],
      }),
    ]);
    const resNo = validateQuestionBatchSalvage(noTable, {});
    expect(resNo.ok).toBe(true);
    if (!resNo.ok) return;
    expect(resNo.rejected[0]?.reason).toBe('references_missing_stimulus');

    const withTable = JSON.stringify([
      item({
        body: 'From the table | Kumasi: 210mm | Tamale: 90mm | Accra: 140mm | which town recorded the highest rainfall?',
        options: [
          { label: 'A', body: 'Kumasi town', isCorrect: true },
          { label: 'B', body: 'Tamale town', isCorrect: false },
          { label: 'C', body: 'Accra city', isCorrect: false },
          { label: 'D', body: 'Takoradi port', isCorrect: false },
        ],
      }),
    ]);
    const resYes = validateQuestionBatchSalvage(withTable, {});
    expect(resYes.ok).toBe(true);
    if (!resYes.ok) return;
    expect(resYes.rejected).toHaveLength(0);
  });

  it('warns (not rejects) when the correct option is much longer than the rest', () => {
    const raw = JSON.stringify([
      item({
        options: [
          {
            label: 'A',
            body: 'a very long and detailed correct option body here',
            isCorrect: true,
          },
          { label: 'B', body: 'short one', isCorrect: false },
          { label: 'C', body: 'also short', isCorrect: false },
          { label: 'D', body: 'tiny too', isCorrect: false },
        ],
      }),
    ]);
    const res = validateQuestionBatchSalvage(raw, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(1);
    expect(
      res.value[0].warnings.some((w) =>
        w.includes('CORRECT option is the longest'),
      ),
    ).toBe(true);
  });
});

describe('shuffleOptions (remediation 0.7)', () => {
  it('preserves the option set, keeps exactly one correct, reassigns A–D labels', () => {
    const q = item() as unknown as ParsedQuestion;
    q.warnings = [];
    const shuffled = shuffleOptions(q);
    expect(shuffled.options).toHaveLength(4);
    expect(shuffled.options.map((o) => o.label)).toEqual(['A', 'B', 'C', 'D']);
    expect(shuffled.options.filter((o) => o.isCorrect)).toHaveLength(1);
    expect(new Set(shuffled.options.map((o) => o.body))).toEqual(
      new Set(q.options.map((o) => o.body)),
    );
  });

  it('spreads the correct answer across positions over many shuffles', () => {
    const q = item() as unknown as ParsedQuestion;
    q.warnings = [];
    const counts = { A: 0, B: 0, C: 0, D: 0 } as Record<string, number>;
    for (let i = 0; i < 400; i++) {
      const s = shuffleOptions(q);
      counts[s.options.find((o) => o.isCorrect)!.label] += 1;
    }
    // Every position sees the correct answer a non-trivial number of
    // times (expected ~100 each; 40 is a generous 6-sigma floor).
    for (const label of ['A', 'B', 'C', 'D']) {
      expect(counts[label]).toBeGreaterThan(40);
    }
  });
});
