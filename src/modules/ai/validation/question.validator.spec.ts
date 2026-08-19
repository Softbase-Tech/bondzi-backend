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

  describe('meta-syllabus rejects', () => {
    it('rejects "According to the syllabus…" stems', () => {
      const q = {
        ...goodQuestion,
        body: 'According to the syllabus, what is the SI unit of force?',
      };
      const r = validateQuestionBatch(batch(q));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('meta_syllabus_reference');
    });

    it('rejects "The curriculum states…" stems', () => {
      const q = {
        ...goodQuestion,
        body: 'The curriculum states that force is measured in what unit?',
      };
      const r = validateQuestionBatch(batch(q));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('meta_syllabus_reference');
    });

    it('rejects "learners assess" outcome-statement phrasing', () => {
      const q = {
        ...goodQuestion,
        body: 'When learners assess rule systems, which region should they focus on studying?',
      };
      const r = validateQuestionBatch(batch(q));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('meta_syllabus_reference');
    });

    it('rejects the bare word "syllabus" in a stem', () => {
      const q = {
        ...goodQuestion,
        body: 'Which SI unit does the syllabus prescribe for measuring force?',
      };
      const r = validateQuestionBatch(batch(q));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('meta_syllabus_reference');
    });

    it('rejects meta phrasing that appears only in the explanation', () => {
      const q = {
        ...goodQuestion,
        explanation:
          'The syllabus explicitly states that Newton is the SI unit of force.',
      };
      const r = validateQuestionBatch(batch(q));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('meta_syllabus_reference');
    });
  });

  describe('trivia + exam-institution rejects', () => {
    it('rejects "In which year was WAEC founded" style stems', () => {
      const q = {
        ...goodQuestion,
        body: 'In which year was WAEC founded to conduct exams in West Africa?',
      };
      const r = validateQuestionBatch(batch(q));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('trivia_meta_question');
    });

    it('rejects "Who is the chief examiner" style stems', () => {
      const q = {
        ...goodQuestion,
        body: 'Who is the chief examiner responsible for BECE mathematics this year?',
      };
      const r = validateQuestionBatch(batch(q));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      // BECE match fires first (word-level) — either reason is a
      // successful reject; we assert the type not the specific one.
      expect(['trivia_meta_question']).toContain(r.reason);
    });
  });

  describe('length + filler-option rejects', () => {
    it('rejects stems shorter than 6 words', () => {
      const q = { ...goodQuestion, body: 'What is force?' };
      const r = validateQuestionBatch(batch(q));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('stem_too_short');
    });

    it('rejects "All of the above" as an option', () => {
      const q = {
        ...goodQuestion,
        body: 'Which of these is a valid SI unit of measurement?',
        options: [
          { label: 'A', body: 'Newton', isCorrect: false },
          { label: 'B', body: 'Pascal', isCorrect: false },
          { label: 'C', body: 'Joule', isCorrect: false },
          { label: 'D', body: 'All of the above', isCorrect: true },
        ],
      };
      const r = validateQuestionBatch(batch(q));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('all_or_none_option');
    });

    it('rejects "None of the above" as an option (case-insensitive)', () => {
      const q = {
        ...goodQuestion,
        body: 'Which of these is a fundamental unit of thermal capacity?',
        options: [
          { label: 'A', body: 'Newton', isCorrect: false },
          { label: 'B', body: 'Pascal', isCorrect: false },
          { label: 'C', body: 'Joule', isCorrect: true },
          { label: 'D', body: 'none of the above', isCorrect: false },
        ],
      };
      const r = validateQuestionBatch(batch(q));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('all_or_none_option');
    });
  });

  describe('stem-leaks-answer reject', () => {
    it('rejects when 4+ consecutive words of the answer appear in the stem', () => {
      const q = {
        body: 'The mitochondrion is often described as the powerhouse of the cell in biology textbooks.',
        difficulty: 'medium',
        options: [
          { label: 'A', body: 'nucleus of the cell', isCorrect: false },
          { label: 'B', body: 'powerhouse of the cell', isCorrect: true },
          {
            label: 'C',
            body: 'endoplasmic reticulum of the cell',
            isCorrect: false,
          },
          { label: 'D', body: 'ribosome of the cell', isCorrect: false },
        ],
        explanation: 'The mitochondrion produces ATP.',
      };
      const r = validateQuestionBatch(batch(q));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('stem_leaks_answer');
    });

    it('accepts short one- or two-word answers that overlap with the stem', () => {
      // "Chad" would match against a syllabus context containing "Chad"
      // but this rule only fires on 4+ token windows.
      const q = {
        body: 'A 6-million-year-old hominid skull discovered in 2002 was announced in which country?',
        difficulty: 'medium',
        options: [
          { label: 'A', body: 'North Africa', isCorrect: false },
          { label: 'B', body: 'East Africa', isCorrect: false },
          { label: 'C', body: 'Chad', isCorrect: true },
          { label: 'D', body: 'Egypt', isCorrect: false },
        ],
        explanation: 'The Sahelanthropus skull was found in Chad.',
      };
      const r = validateQuestionBatch(batch(q));
      expect(r.ok).toBe(true);
    });
  });
});
