import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WeaknessService } from './weakness.service';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import { QuestionPool } from '../../common/types/enums';

/**
 * WeaknessService — two independent aggregates, past-paper vs syllabus. The
 * queries are complex enough that we don't try to test the raw SQL string;
 * instead we pin behaviour at the boundary:
 *
 *   - answered_at IS NOT NULL is enforced (in-progress answers don't count)
 *   - question_pool filter picks the right table
 *   - subjectId filter, when passed, narrows the aggregate
 *   - MIN_SAMPLES=3 / TOP_N=5 stays as-is (a change would break the picker)
 *
 * Runs against a mocked query builder — the real SQL is covered by
 * integration tests once we have them.
 */
describe('WeaknessService', () => {
  let service: WeaknessService;
  let answersRepo: { createQueryBuilder: jest.Mock };
  let pastQb: {
    innerJoin: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    select: jest.Mock;
    addSelect: jest.Mock;
    groupBy: jest.Mock;
    addGroupBy: jest.Mock;
    having: jest.Mock;
    orderBy: jest.Mock;
    limit: jest.Mock;
    getRawMany: jest.Mock;
  };
  let syllabusQb: typeof pastQb;

  function makeQbStub(rows: unknown[]): typeof pastQb {
    const qb = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      having: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rows),
    };
    return qb;
  }

  beforeEach(async () => {
    pastQb = makeQbStub([
      { topicId: 't-1', title: 'Vectors', answered: 10, correct: 3 },
      { topicId: 't-2', title: 'Probability', answered: 6, correct: 4 },
    ]);
    syllabusQb = makeQbStub([
      {
        syllabusTopicId: 's-1',
        title: 'Kinematics',
        formLevel: 2,
        answered: 8,
        correct: 2,
      },
    ]);
    answersRepo = {
      createQueryBuilder: jest
        .fn()
        // WeaknessService.forUser fires two Promise.all queries in order:
        // pastPaperWeakness first, then syllabusWeakness.
        .mockReturnValueOnce(pastQb)
        .mockReturnValueOnce(syllabusQb),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        WeaknessService,
        { provide: getRepositoryToken(ExamAnswer), useValue: answersRepo },
      ],
    }).compile();
    service = moduleRef.get(WeaknessService);
  });

  it('returns both aggregates in one response', async () => {
    const out = await service.forUser('user-1', {});
    expect(out.pastPaperWeakTopics).toHaveLength(2);
    expect(out.syllabusWeakTopics).toHaveLength(1);
    // Accuracy is computed from correct/answered.
    expect(out.pastPaperWeakTopics[0].accuracy).toBeCloseTo(0.3);
    expect(out.syllabusWeakTopics[0].accuracy).toBeCloseTo(0.25);
  });

  it('filters answered_at IS NOT NULL on each aggregate (in-progress excluded)', async () => {
    await service.forUser('user-1', {});
    const pastConditions = pastQb.andWhere.mock.calls.map((c) => c[0]);
    const syllabusConditions = syllabusQb.andWhere.mock.calls.map((c) => c[0]);
    expect(pastConditions).toContain('a.answered_at IS NOT NULL');
    expect(syllabusConditions).toContain('a.answered_at IS NOT NULL');
  });

  it('scopes each aggregate to its own question_pool', async () => {
    await service.forUser('user-1', {});
    const pastWhereCall = pastQb.where.mock.calls[0];
    expect(pastWhereCall[1]).toEqual({ pp: QuestionPool.PAST_PAPER });
    const syllWhereCall = syllabusQb.where.mock.calls[0];
    expect(syllWhereCall[1]).toEqual({ pt: QuestionPool.PM_TEST });
  });

  it('applies subjectId to both aggregates when provided', async () => {
    await service.forUser('user-1', { subjectId: 'subj-1' });
    const pastConditions = pastQb.andWhere.mock.calls;
    const syllabusConditions = syllabusQb.andWhere.mock.calls;
    expect(
      pastConditions.some(
        (c) =>
          typeof c[0] === 'string' &&
          c[0].includes('subject_id') &&
          c[1]?.sid === 'subj-1',
      ),
    ).toBe(true);
    expect(
      syllabusConditions.some(
        (c) =>
          typeof c[0] === 'string' &&
          c[0].includes('subject_id') &&
          c[1]?.sid === 'subj-1',
      ),
    ).toBe(true);
  });

  it('omits the subject_id filter when subjectId is not provided', async () => {
    await service.forUser('user-1', {});
    const pastHasSubject = pastQb.andWhere.mock.calls.some(
      (c) => typeof c[0] === 'string' && c[0].includes('subject_id'),
    );
    expect(pastHasSubject).toBe(false);
  });

  it('caps to TOP_N=5 per aggregate', async () => {
    await service.forUser('user-1', {});
    expect(pastQb.limit).toHaveBeenCalledWith(5);
    expect(syllabusQb.limit).toHaveBeenCalledWith(5);
  });

  it('enforces MIN_SAMPLES=3 via HAVING on each aggregate', async () => {
    await service.forUser('user-1', {});
    expect(pastQb.having).toHaveBeenCalledWith(expect.stringContaining('>= 3'));
    expect(syllabusQb.having).toHaveBeenCalledWith(
      expect.stringContaining('>= 3'),
    );
  });
});
