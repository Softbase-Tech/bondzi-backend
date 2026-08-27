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
    isQuantitativeSubject: false,
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
    expect(system).toMatch(/draw on your\s+general knowledge of the\s+subject/);
    // Reference material, when retrieved, is the primary fact source.
    expect(system).toContain('reference_material');
  });

  it('does NOT beg the model for answer-position balance (shuffled server-side)', () => {
    // Remediation 0.7: position balance is enforced in code after
    // validation — the old prompt rule is deliberately gone from both
    // the shell and the user turn.
    const { system, user } = buildQuestionGenerationPrompt({
      ...base,
      pastPaperExemplars: [],
    });
    expect(user).not.toMatch(/Distribute the correct answers roughly evenly/);
    expect(system).not.toMatch(/Distribute correct answers roughly evenly/);
    expect(user).toContain('shuffled after generation');
  });

  it('ships explanation rules only when inline explanations are requested (remediation 0.6)', () => {
    const withExpl = buildQuestionGenerationPrompt({
      ...base,
      includeExplanations: true,
      pastPaperExemplars: [],
    });
    const withoutExpl = buildQuestionGenerationPrompt({
      ...base,
      includeExplanations: false,
      pastPaperExemplars: [],
    });
    expect(withExpl.system).toContain('Explanation rules:');
    expect(withoutExpl.system).not.toContain('Explanation rules:');
  });

  it('wraps untrusted interpolations in <data> blocks (remediation 1.8)', () => {
    const { system, user } = buildQuestionGenerationPrompt({
      ...base,
      pastPaperExemplars: [],
    });
    expect(user).toContain('<data type="syllabus_context">');
    expect(system).toContain('never');
    expect(system).toContain('Data-block rules');
  });
});
