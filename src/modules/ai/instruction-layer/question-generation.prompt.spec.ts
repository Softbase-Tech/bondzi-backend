import { buildQuestionGenerationPrompt } from './question-generation.prompt';
import { ExamType } from '../../../common/types/enums';

describe('buildQuestionGenerationPrompt', () => {
  const base = {
    examType: ExamType.WASSCE,
    subjectName: 'History',
    formLevel: 2 as number | null,
    difficulty: 'medium' as const,
    count: 3,
    topicTitle: 'Colonial rule in West Africa',
    syllabusContext:
      '- learners assess indirect and direct rule systems in West Africa',
    includeExplanations: true,
  };

  it('includes the topic scope and count on every batch', () => {
    const { user } = buildQuestionGenerationPrompt({
      ...base,
      pastPaperExemplars: [],
    });
    expect(user).toContain('Subject: History');
    expect(user).toContain('Topic: Colonial rule in West Africa');
    expect(user).toContain('Count: 3');
    expect(user).toContain('Syllabus scope');
  });

  it('renders the exemplar block when past-paper questions are provided', () => {
    const { user } = buildQuestionGenerationPrompt({
      ...base,
      pastPaperExemplars: [
        {
          body: 'Who introduced the policy of indirect rule in Northern Nigeria?',
          options: [
            { label: 'A', body: 'Frederick Lugard', isCorrect: true },
            { label: 'B', body: 'Kwame Nkrumah', isCorrect: false },
            { label: 'C', body: 'Léopold Senghor', isCorrect: false },
            { label: 'D', body: 'Nnamdi Azikiwe', isCorrect: false },
          ],
          explanation:
            'Frederick Lugard formalised indirect rule as governor of Northern Nigeria in the early 1900s, using traditional emirs as intermediaries.',
          year: 2012,
          paper: 2,
          difficulty: 'medium',
        },
      ],
    });
    expect(user).toContain('Past-paper reference questions');
    expect(user).toContain('Frederick Lugard');
    expect(user).toContain('← correct');
    expect(user).toContain('2012');
    expect(user).toContain('Paper 2');
  });

  it('omits the exemplar block entirely when the list is empty', () => {
    const { user } = buildQuestionGenerationPrompt({
      ...base,
      pastPaperExemplars: [],
    });
    expect(user).not.toContain('Past-paper reference questions');
    expect(user).not.toContain('← correct');
  });

  it('drops the form line for NOVDEC (formLevel = null)', () => {
    const { user } = buildQuestionGenerationPrompt({
      ...base,
      formLevel: null,
      pastPaperExemplars: [],
    });
    expect(user).toContain('NOVDEC candidate');
    expect(user).not.toContain('Level: Form');
  });

  it('the system shell bans meta-syllabus phrasing verbatim', () => {
    const { system } = buildQuestionGenerationPrompt({
      ...base,
      pastPaperExemplars: [],
    });
    expect(system).toContain('According to the syllabus');
    expect(system).toContain('learners assess');
    expect(system).toMatch(
      /word "syllabus" and the word "curriculum" must not/,
    );
  });

  it('the system shell splits scope from source', () => {
    const { system } = buildQuestionGenerationPrompt({
      ...base,
      pastPaperExemplars: [],
    });
    expect(system).toContain('SCOPE vs SOURCE');
    expect(system).toMatch(
      /Draw the FACTS in your questions from your general knowledge/,
    );
  });

  it('the system shell requires evenly distributed correct answers', () => {
    const { user } = buildQuestionGenerationPrompt({
      ...base,
      pastPaperExemplars: [],
    });
    expect(user).toMatch(/Distribute the correct answers roughly evenly/);
  });
});
