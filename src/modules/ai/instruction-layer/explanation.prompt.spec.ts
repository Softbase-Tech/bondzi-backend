import { buildExplanationPrompt } from './explanation.prompt';
import { ExamType } from '../../../common/types/enums';

const base = {
  examType: ExamType.WASSCE,
  subjectName: 'English Language',
  formLevel: 2,
  questionBody:
    'According to the passage, why did Kofi refuse to sell the family land?',
  options: [
    { label: 'A', body: 'It held his ancestors' },
    { label: 'B', body: 'It was too small' },
    { label: 'C', body: 'The price was low' },
    { label: 'D', body: 'He feared the chief' },
  ],
  correctLabel: 'A',
};

describe('buildExplanationPrompt — stimulus handling', () => {
  it('injects the shared stimulus as a <data type="stimulus"> block before the question', () => {
    const { user } = buildExplanationPrompt({
      ...base,
      stimulus: {
        title: 'The Family Land',
        body: 'Kofi stood at the edge of the farm his grandfather had cleared…',
      },
    });
    expect(user).toContain('<data type="stimulus">');
    expect(user).toContain('The Family Land');
    expect(user).toContain('his grandfather had cleared');
    // Stimulus must appear BEFORE the question so the model reads the
    // passage first, mirroring how the student encounters it.
    expect(user.indexOf('<data type="stimulus">')).toBeLessThan(
      user.indexOf('<data type="question">'),
    );
  });

  it('omits the stimulus block entirely when no stimulus is supplied', () => {
    const { user } = buildExplanationPrompt(base);
    expect(user).not.toContain('<data type="stimulus">');
  });

  it('omits the stimulus block for an empty-body stimulus', () => {
    const { user } = buildExplanationPrompt({
      ...base,
      stimulus: { title: 'Figure 3', body: '   ' },
    });
    expect(user).not.toContain('<data type="stimulus">');
  });

  it('still supplies the correct option text and key-verification reminder', () => {
    const { user } = buildExplanationPrompt(base);
    expect(user).toContain('Provided correct answer: "It held his ancestors"');
    expect(user).toContain('solve the question independently FIRST');
  });
});
