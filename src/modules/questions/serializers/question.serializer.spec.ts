import { Question } from '../entities/question.entity';
import { Option } from '../entities/option.entity';
import { toStudentQuestion } from './question.serializer';
import {
  Difficulty,
  QuestionSource,
  QuestionType,
} from '../../../common/types/enums';
import { PmTestOption } from '../../pm-test/entities/pm-test-option.entity';
import { PmTestQuestion } from '../../pm-test/entities/pm-test-question.entity';
import { toStudentPmTestQuestion } from '../../pm-test/serializers/pm-test.serializer';

/**
 * [SEC] These tests are the hard line between a student and the answer key.
 * A regression here ships a broken product: if `isCorrect` leaks, every
 * student can open DevTools and see which option is right before tapping.
 *
 * Covers:
 *   - Past paper Question serializer (toStudentQuestion)
 *   - PM Test Question serializer (toStudentPmTestQuestion)
 *   - hasExplanation flag truthfulness
 *   - Subscription gating on explanation body
 */

function makeQuestion(overrides: Partial<Question> = {}): Question {
  const q = new Question();
  q.id = 'q1';
  q.subjectId = 's1';
  q.topicId = null;
  q.questionType = QuestionType.MCQ;
  q.source = QuestionSource.WASSCE_PAST;
  q.body = 'What is 2+2?';
  q.bodyHtml = null;
  q.imageUrl = null;
  q.year = 2020;
  q.wassecPaper = 1;
  q.section = 'A';
  q.difficulty = Difficulty.EASY;
  q.tags = ['arithmetic'];
  q.explanation = null;
  q.explanationHtml = null;
  q.isVerified = true;
  q.options = [
    Object.assign(new Option(), {
      id: 'o1',
      label: 'A',
      body: '3',
      bodyHtml: null,
      imageUrl: null,
      isCorrect: false,
      sortOrder: 0,
    }),
    Object.assign(new Option(), {
      id: 'o2',
      label: 'B',
      body: '4',
      bodyHtml: null,
      imageUrl: null,
      isCorrect: true,
      sortOrder: 1,
    }),
    Object.assign(new Option(), {
      id: 'o3',
      label: 'C',
      body: '5',
      bodyHtml: null,
      imageUrl: null,
      isCorrect: false,
      sortOrder: 2,
    }),
  ];
  return Object.assign(q, overrides);
}

describe('toStudentQuestion', () => {
  it('never leaks isCorrect to the student response', () => {
    const student = toStudentQuestion(makeQuestion());
    for (const opt of student.options) {
      expect(Object.prototype.hasOwnProperty.call(opt, 'isCorrect')).toBe(
        false,
      );
    }
    expect(JSON.stringify(student)).not.toContain('isCorrect');
  });

  it('preserves option order by sortOrder then label', () => {
    const student = toStudentQuestion(makeQuestion());
    expect(student.options.map((o) => o.label)).toEqual(['A', 'B', 'C']);
  });

  it('always sets correctAnswer to null on the student shape', () => {
    const student = toStudentQuestion(makeQuestion());
    expect(student.correctAnswer).toBeNull();
  });

  describe('hasExplanation flag', () => {
    it('is false when no explanation is stored', () => {
      const student = toStudentQuestion(makeQuestion({ explanation: null }));
      expect(student.hasExplanation).toBe(false);
      expect(student.explanation).toBeNull();
      expect(student.explanationHtml).toBeNull();
    });

    it('is true when explanation is stored — regardless of subscription', () => {
      const q = makeQuestion({
        explanation: 'Because 2+2=4 by definition of addition.',
        explanationHtml: '<p>Because 2+2=4 by definition of addition.</p>',
      });
      expect(toStudentQuestion(q).hasExplanation).toBe(true);
      expect(
        toStudentQuestion(q, { hasActiveSubscription: true }).hasExplanation,
      ).toBe(true);
    });
  });

  describe('math rendering on the student `text` field', () => {
    it('replaces $...$ with an inline SVG data URI', () => {
      const q = makeQuestion({
        body: 'Simplify $\\dfrac{5^7 \\times 5^4}{5^2}$',
      });
      const s = toStudentQuestion(q);
      expect(s.text).toMatch(/!\[math\]\(data:image\/svg\+xml;base64,/);
      // The original LaTeX delimiters must not survive — mobile would render
      // them as literal text otherwise.
      expect(s.text).not.toContain('$\\dfrac');
      // Plain prose is preserved untouched.
      expect(s.text).toContain('Simplify ');
    });

    it('renders math in option text too', () => {
      const q = makeQuestion();
      q.options[0].body = '$5^7$';
      const s = toStudentQuestion(q);
      expect(s.options[0].text).toMatch(/!\[math\]\(data:image\/svg\+xml/);
    });

    it('leaves plain text bodies unchanged', () => {
      const s = toStudentQuestion(makeQuestion());
      expect(s.text).toBe('What is 2+2?');
    });
  });

  describe('subscription gating on explanation body', () => {
    const q = makeQuestion({
      explanation: 'Full tutor explanation here.',
      explanationHtml: '<p>Full tutor explanation here.</p>',
    });

    it('hides the explanation text for free users (default)', () => {
      const s = toStudentQuestion(q);
      expect(s.hasExplanation).toBe(true);
      expect(s.explanation).toBeNull();
      expect(s.explanationHtml).toBeNull();
    });

    it('shows the explanation text for subscribed users', () => {
      const s = toStudentQuestion(q, { hasActiveSubscription: true });
      expect(s.explanation).toBe('Full tutor explanation here.');
      expect(s.explanationHtml).toBe('<p>Full tutor explanation here.</p>');
    });

    it('hides the explanation when hasExplanation is false, even for subscribed users', () => {
      const noExpl = makeQuestion({ explanation: null });
      const s = toStudentQuestion(noExpl, { hasActiveSubscription: true });
      expect(s.hasExplanation).toBe(false);
      expect(s.explanation).toBeNull();
    });
  });
});

describe('toStudentPmTestQuestion', () => {
  function makePmQ(): PmTestQuestion {
    const q = new PmTestQuestion();
    q.id = 'pm1';
    q.subjectId = 's1';
    q.syllabusTopicId = 'st1';
    q.formLevel = 3;
    q.examType = 'wassce' as PmTestQuestion['examType'];
    q.body = 'Sample PM Test question';
    q.difficulty = Difficulty.MEDIUM;
    q.explanation = 'Explanation body.';
    q.options = [
      Object.assign(new PmTestOption(), {
        id: 'o1',
        label: 'A',
        body: 'wrong',
        isCorrect: false,
      }),
      Object.assign(new PmTestOption(), {
        id: 'o2',
        label: 'B',
        body: 'right',
        isCorrect: true,
      }),
    ];
    return q;
  }

  it('never leaks isCorrect for PM Test options', () => {
    const s = toStudentPmTestQuestion(makePmQ());
    for (const opt of s.options) {
      expect(Object.prototype.hasOwnProperty.call(opt, 'isCorrect')).toBe(
        false,
      );
    }
    expect(JSON.stringify(s)).not.toContain('isCorrect');
  });

  it('includes the inline explanation (PM Test is subscription-gated at the route level)', () => {
    const s = toStudentPmTestQuestion(makePmQ());
    expect(s.explanation).toBe('Explanation body.');
  });
});
