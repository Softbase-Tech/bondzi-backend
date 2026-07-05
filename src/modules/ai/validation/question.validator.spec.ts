import { validateQuestionBatch } from './question.validator';

const goodQuestion = {
  body: 'What is the SI unit of force?',
  difficulty: 'easy',
  options: [
    { label: 'A', body: 'Joule', isCorrect: false },
    { label: 'B', body: 'Newton', isCorrect: true },
    { label: 'C', body: 'Pascal', isCorrect: false },
    { label: 'D', body: 'Watt', isCorrect: false },
  ],
  explanation: '',
};

function batch(...qs: unknown[]): string {
  return JSON.stringify(qs);
}

describe('validateQuestionBatch', () => {
  describe('positive path', () => {
    it('accepts a valid batch and returns typed questions', () => {
      const result = validateQuestionBatch(batch(goodQuestion));
      if (!result.ok) throw new Error('expected ok=true');
      expect(result.value).toHaveLength(1);
      expect(result.value[0].body).toBe('What is the SI unit of force?');
      expect(result.value[0].options.filter((o) => o.isCorrect)).toHaveLength(
        1,
      );
    });

    it('strips ```json fences that a chatty model sometimes emits', () => {
      const wrapped = '```json\n' + batch(goodQuestion) + '\n```';
      const result = validateQuestionBatch(wrapped);
      expect(result.ok).toBe(true);
    });
  });

  describe('structure failures', () => {
    it('rejects unparseable JSON as schema_invalid', () => {
      const result = validateQuestionBatch('not-json {[');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('schema_invalid');
    });

    it('rejects a top-level object as not_an_array', () => {
      const result = validateQuestionBatch(JSON.stringify(goodQuestion));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('not_an_array');
    });

    it('rejects an empty array as empty_batch', () => {
      const result = validateQuestionBatch('[]');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('empty_batch');
    });

    it('rejects the JSON refusal shape as model_refused', () => {
      const result = validateQuestionBatch(
        JSON.stringify({
          error: 'out_of_syllabus',
          detail: 'topic X is not in the F1 syllabus',
        }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('model_refused');
      expect(result.detail).toContain('not in the F1 syllabus');
    });
  });

  describe('per-question rules', () => {
    it('(b) rejects an empty stem', () => {
      const result = validateQuestionBatch(
        batch({ ...goodQuestion, body: '   ' }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('empty_stem');
    });

    it('rejects when options count is not 4', () => {
      const result = validateQuestionBatch(
        batch({ ...goodQuestion, options: goodQuestion.options.slice(0, 3) }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('wrong_option_count');
    });

    it('(c) rejects an empty option body', () => {
      const result = validateQuestionBatch(
        batch({
          ...goodQuestion,
          options: goodQuestion.options.map((o, i) =>
            i === 1 ? { ...o, body: '  ' } : o,
          ),
        }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('empty_option');
    });

    it('(d) NEW — rejects duplicate option text case-insensitively', () => {
      const result = validateQuestionBatch(
        batch({
          ...goodQuestion,
          options: [
            { label: 'A', body: 'Newton', isCorrect: false },
            { label: 'B', body: 'newton', isCorrect: true },
            { label: 'C', body: 'Pascal', isCorrect: false },
            { label: 'D', body: 'Watt', isCorrect: false },
          ],
        }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('duplicate_option_text');
    });

    it('(a) rejects when no option is flagged isCorrect', () => {
      const result = validateQuestionBatch(
        batch({
          ...goodQuestion,
          options: goodQuestion.options.map((o) => ({
            ...o,
            isCorrect: false,
          })),
        }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('no_correct');
    });

    it('(a) rejects when multiple options are flagged isCorrect', () => {
      const result = validateQuestionBatch(
        batch({
          ...goodQuestion,
          options: goodQuestion.options.map((o, i) => ({
            ...o,
            isCorrect: i < 2, // A + B both true
          })),
        }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('multiple_correct');
    });

    it('(e) NEW — rejects when a wildcard correctAnswer field disagrees with isCorrect', () => {
      const result = validateQuestionBatch(
        batch({
          ...goodQuestion,
          // isCorrect flags B/Newton as correct, but the wildcard
          // field says "D. Watt" — mismatch. This is the failure
          // mode weaker models produce when they add unprompted fields.
          correctAnswer: 'D. Watt',
        }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('correct_answer_field_mismatch');
    });

    it('(e) NEW — accepts when the wildcard correctAnswer field matches by label', () => {
      const result = validateQuestionBatch(
        batch({ ...goodQuestion, correctAnswer: 'B' }),
      );
      expect(result.ok).toBe(true);
    });

    it('(e) NEW — accepts when the wildcard correctAnswer field matches by body substring', () => {
      const result = validateQuestionBatch(
        batch({ ...goodQuestion, answer: 'The correct answer is Newton.' }),
      );
      expect(result.ok).toBe(true);
    });
  });
});
