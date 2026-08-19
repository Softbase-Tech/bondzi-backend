import { looksLikeCalcQuestion } from './looks-like-calc.util';

describe('looksLikeCalcQuestion', () => {
  it('flags a stem that begins with "Solve"', () => {
    expect(
      looksLikeCalcQuestion({
        stem: 'Solve x^2 + 2x - 8 = 0 using the quadratic formula.',
        options: [
          { body: 'x = 2 or x = -4' },
          { body: 'x = -2 or x = 4' },
          { body: 'x = 1 or x = -8' },
          { body: 'x = 4 or x = -2' },
        ],
      }),
    ).toBe(true);
  });

  it('flags a stem with LaTeX inline math', () => {
    expect(
      looksLikeCalcQuestion({
        stem: 'Given $f(x) = 3x + 1$, what is $f(4)$?',
        options: [{ body: '9' }, { body: '13' }, { body: '4' }, { body: '12' }],
      }),
    ).toBe(true);
  });

  it('flags a question with unit-carrying options', () => {
    expect(
      looksLikeCalcQuestion({
        stem: 'A car accelerates from rest to reach top speed in ten seconds.',
        options: [
          { body: '2 m/s^2' },
          { body: '5 m/s^2' },
          { body: '10 m/s^2' },
          { body: '20 m/s^2' },
        ],
      }),
    ).toBe(true);
  });

  it('flags a question whose options are almost all pure numbers', () => {
    expect(
      looksLikeCalcQuestion({
        stem: 'How many students attended the lecture on the third day?',
        options: [
          { body: '42' },
          { body: '55' },
          { body: '73' },
          { body: '108' },
        ],
      }),
    ).toBe(true);
  });

  it('flags a currency-answer question', () => {
    expect(
      looksLikeCalcQuestion({
        stem: 'If a shopkeeper marks up a book by 20%, what is the new price?',
        options: [
          { body: 'GH₵ 45' },
          { body: 'GH₵ 60' },
          { body: 'GH₵ 72' },
          { body: 'GH₵ 90' },
        ],
      }),
    ).toBe(true);
  });

  it('does NOT flag a conceptual recall question with word options', () => {
    expect(
      looksLikeCalcQuestion({
        stem: 'Which organelle is primarily responsible for ATP synthesis?',
        options: [
          { body: 'Nucleus' },
          { body: 'Mitochondrion' },
          { body: 'Ribosome' },
          { body: 'Golgi apparatus' },
        ],
      }),
    ).toBe(false);
  });

  it('does NOT flag a history stem that happens to contain hyphens or a year', () => {
    // Regression: a bare hyphen in a compound adjective (or a year
    // range) was previously misdetected as an arithmetic operator.
    expect(
      looksLikeCalcQuestion({
        stem: 'A 6-million-year-old hominid skull discovered in 2002 was announced in which country?',
        options: [
          { body: 'North Africa' },
          { body: 'East Africa' },
          { body: 'Chad' },
          { body: 'Egypt' },
        ],
      }),
    ).toBe(false);
  });

  it('does NOT flag a definition question', () => {
    expect(
      looksLikeCalcQuestion({
        stem: 'Define the term "photosynthesis" as used in plant biology.',
        options: [
          { body: 'Conversion of sugar to oxygen in leaves' },
          { body: 'Conversion of light energy to chemical energy' },
          { body: 'Breakdown of glucose in mitochondria' },
          { body: 'Growth of plant roots underground' },
        ],
      }),
    ).toBe(false);
  });
});
