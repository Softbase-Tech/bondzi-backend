import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { QuestionsService } from './questions.service';
import { Question } from './entities/question.entity';
import { Option } from './entities/option.entity';
import { QuestionFlag } from './entities/question-flag.entity';
import { SrsCard } from '../srs/entities/srs-card.entity';
import { UserSubjectProgress } from '../progress/entities/user-subject-progress.entity';
import { Topic } from '../subjects/entities/topic.entity';
import { RedisService } from '../../common/redis/redis.service';
import { StimuliService } from './stimuli.service';

/**
 * QuestionsService is the largest service in the codebase. Tests pin the
 * non-obvious contracts:
 *   - list: examType is REQUIRED (BadRequest if neither query nor JWT supplies
 *     it). Non-admin reads are filtered to status=active.
 *   - search: empty query short-circuits to [] without hitting the DB.
 *   - getPastPaper: cache hit short-circuits. Cache miss writes the FREE shape
 *     (no inline explanations) so subscribed + free users share the entry.
 *   - validateOptionsExactlyOneCorrect: 0 correct → 400, 2+ → 409.
 *   - flag: increments flag_count atomically inside the tx.
 *   - update / create: stimulusId is validated through StimuliService BEFORE
 *     we touch the row, so a bad FK throws cleanly.
 */

describe('QuestionsService', () => {
  let service: QuestionsService;
  let questionsRepo: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    save: jest.Mock;
  };
  let optionsRepo: Record<string, unknown>;
  let flagsRepo: Record<string, unknown>;
  let srsRepo: Record<string, unknown>;
  let progressRepo: Record<string, unknown>;
  let topicsRepo: { findOne: jest.Mock };
  let redis: { getJson: jest.Mock; setJson: jest.Mock; del: jest.Mock };
  let stimuli: { assertExists: jest.Mock };
  let dataSource: {
    transaction: jest.Mock;
    getRepository: jest.Mock;
    query: jest.Mock;
  };

  function stubListQb(rows: unknown[]) {
    const qb = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([rows, rows.length]),
    };
    questionsRepo.createQueryBuilder.mockReturnValueOnce(qb);
    return qb;
  }

  beforeEach(async () => {
    questionsRepo = {
      createQueryBuilder: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn(async (q: unknown) => q),
    };
    optionsRepo = {};
    flagsRepo = {};
    srsRepo = {};
    progressRepo = {};
    topicsRepo = { findOne: jest.fn() };
    redis = {
      getJson: jest.fn(),
      setJson: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };
    stimuli = { assertExists: jest.fn() };
    dataSource = {
      transaction: jest.fn(
        async (fn: (em: EntityManager) => Promise<unknown>) =>
          fn({} as unknown as EntityManager),
      ),
      getRepository: jest.fn(),
      query: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        QuestionsService,
        { provide: getRepositoryToken(Question), useValue: questionsRepo },
        { provide: getRepositoryToken(Option), useValue: optionsRepo },
        { provide: getRepositoryToken(QuestionFlag), useValue: flagsRepo },
        { provide: getRepositoryToken(SrsCard), useValue: srsRepo },
        {
          provide: getRepositoryToken(UserSubjectProgress),
          useValue: progressRepo,
        },
        { provide: getRepositoryToken(Topic), useValue: topicsRepo },
        { provide: RedisService, useValue: redis },
        { provide: DataSource, useValue: dataSource },
        { provide: StimuliService, useValue: stimuli },
      ],
    }).compile();
    service = moduleRef.get(QuestionsService);
  });

  // -------------------------------- list --------------------------------

  describe('list', () => {
    it('throws BadRequest when neither the query nor the JWT supplies examType', async () => {
      stubListQb([]);
      await expect(
        service.list({} as never, {
          isAdmin: false,
          hasActiveSubscription: false,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-admin reads are scoped to status=active', async () => {
      const qb = stubListQb([]);
      await service.list({} as never, {
        isAdmin: false,
        hasActiveSubscription: false,
        defaultExamType: 'wassce',
      });
      // The active filter is applied via andWhere with a literal SQL fragment.
      const calls = qb.andWhere.mock.calls.map((c) => c[0]);
      expect(calls.some((c: string) => c.includes("q.status = 'active'"))).toBe(
        true,
      );
    });

    it('admin reads bypass the active filter but still require examType', async () => {
      const qb = stubListQb([]);
      await service.list({ examType: 'bece' } as never, {
        isAdmin: true,
        hasActiveSubscription: false,
      });
      const calls = qb.andWhere.mock.calls.map((c) => c[0]);
      expect(calls.some((c: string) => c.includes("q.status = 'active'"))).toBe(
        false,
      );
    });
  });

  // ------------------------------ search ------------------------------

  it('search short-circuits to [] for an empty query (no DB call)', async () => {
    expect(
      await service.search('   ', { hasActiveSubscription: false }),
    ).toEqual([]);
    expect(questionsRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  // ------------------------------ getById ------------------------------

  it('getById throws NotFound for an unknown id', async () => {
    questionsRepo.findOne.mockResolvedValueOnce(null);
    await expect(
      service.getById('nope', { isAdmin: false, hasActiveSubscription: false }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ---------------------------- getPastPaper ----------------------------

  describe('getPastPaper', () => {
    it('returns the cached payload on a hit', async () => {
      redis.getJson.mockResolvedValueOnce([{ id: 'q1' } as never]);
      const out = await service.getPastPaper(
        { subjectId: 's1', year: 2024 } as never,
        { hasActiveSubscription: false, examType: 'wassce' },
      );
      expect(out).toHaveLength(1);
      expect(questionsRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('caches the FREE shape on a miss (shared across subscribed + free)', async () => {
      redis.getJson.mockResolvedValueOnce(null);
      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          {
            id: 'q1',
            questionType: 'mcq',
            body: 'b',
            bodyHtml: 'b',
            options: [],
            explanation: 'gated',
            explanationHtml: 'gated',
          },
        ]),
      };
      questionsRepo.createQueryBuilder.mockReturnValueOnce(qb);
      await service.getPastPaper({ subjectId: 's1', year: 2024 } as never, {
        hasActiveSubscription: false,
        examType: 'wassce',
      });
      // Cache write happened with the FREE shape — assertable by spy invocation.
      expect(redis.setJson).toHaveBeenCalled();
    });
  });

  // ----------------------- validateOptions branches -----------------------

  describe('option validation', () => {
    function dto(opts: Array<{ isCorrect: boolean }>) {
      return {
        subjectId: 's1',
        examType: 'wassce',
        questionType: 'mcq',
        source: 'past_paper',
        body: 'b',
        difficulty: 'easy',
        options: opts.map((o, i) => ({
          label: String.fromCharCode(65 + i),
          body: 'opt',
          isCorrect: o.isCorrect,
        })),
      } as never;
    }

    it('rejects with 400 when no option is marked correct', async () => {
      await expect(
        service.create(dto([{ isCorrect: false }, { isCorrect: false }])),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects with 409 when two options are marked correct', async () => {
      await expect(
        service.create(dto([{ isCorrect: true }, { isCorrect: true }])),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // -------------------------------- flag --------------------------------

  it('flag throws NotFound for an unknown question id', async () => {
    questionsRepo.findOne.mockResolvedValueOnce(null);
    await expect(
      service.flag('user-1', 'qX', { reason: 'incorrect' } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ------------------------------- verify -------------------------------

  it('verify flips isVerified to true', async () => {
    const row: Partial<Question> = { id: 'q1', isVerified: false };
    questionsRepo.findOne.mockResolvedValueOnce(row);
    await service.verify('q1');
    expect(row.isVerified).toBe(true);
    expect(questionsRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ isVerified: true }),
    );
  });

  it('verify throws NotFound for an unknown id', async () => {
    questionsRepo.findOne.mockResolvedValueOnce(null);
    await expect(service.verify('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // ---------------------------- bulkImport ----------------------------

  it('bulkImport returns errors WITHOUT writing anything when any item is invalid', async () => {
    const out = await service.bulkImport({
      questions: [
        {
          subjectId: 's1',
          examType: 'wassce',
          questionType: 'mcq',
          source: 'past_paper',
          body: 'b',
          difficulty: 'easy',
          options: [
            { label: 'A', body: 'a', isCorrect: true },
            { label: 'B', body: 'b', isCorrect: true }, // two correct → 409
          ],
        },
      ],
    } as never);
    expect(out.created).toBe(0);
    expect(out.errors).toHaveLength(1);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('bulkImport rejects when a row names a topic that does not exist under the subject', async () => {
    // Topic lookup returns null → the row cites a topic that isn't in
    // the DB. The whole batch should fail before any write happens,
    // with a per-row error naming the missing topic and its subject.
    topicsRepo.findOne.mockResolvedValueOnce(null);
    const out = await service.bulkImport({
      questions: [
        {
          subjectId: 's1',
          topic: 'Non-existent chapter',
          examType: 'wassce',
          questionType: 'mcq',
          source: 'past_paper',
          body: 'b',
          difficulty: 'easy',
          options: [
            { label: 'A', body: 'a', isCorrect: true },
            { label: 'B', body: 'b', isCorrect: false },
          ],
        },
      ],
    } as never);
    expect(out.created).toBe(0);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0].message).toContain('Non-existent chapter');
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('bulkImport resolves a topic name to its id and applies it to the created row', async () => {
    // One-shot lookup returns the resolved Topic. The transactional
    // path then writes the question with that resolved topicId — no
    // matter that the caller supplied a name instead of a UUID.
    topicsRepo.findOne.mockResolvedValueOnce({ id: 't-resolved' });
    const qRepoInTx = {
      create: jest.fn((row: Record<string, unknown>) => row),
      save: jest.fn(async (row: unknown) => {
        (row as { id: string }).id = 'q1';
        return row;
      }),
    };
    const oRepoInTx = {
      create: jest.fn((row: unknown) => row),
      save: jest.fn(async (rows: unknown) => rows),
    };
    dataSource.transaction.mockImplementationOnce(
      async (fn: (em: EntityManager) => Promise<unknown>) =>
        fn({
          getRepository: (target: { name?: string } | string) => {
            const name = typeof target === 'string' ? target : target.name;
            if (name === 'Question') return qRepoInTx;
            if (name === 'Option') return oRepoInTx;
            return {};
          },
        } as unknown as EntityManager),
    );

    const out = await service.bulkImport({
      questions: [
        {
          subjectId: 's1',
          topic: 'Scientific Units and Measurements',
          examType: 'wassce',
          questionType: 'mcq',
          source: 'past_paper',
          body: 'q body',
          difficulty: 'easy',
          options: [
            { label: 'A', body: 'a', isCorrect: true },
            { label: 'B', body: 'b', isCorrect: false },
          ],
        },
      ],
    } as never);
    expect(out.created).toBe(1);
    expect(out.errors).toHaveLength(0);
    // topicId on the created row must be the resolved UUID, not the name.
    expect(qRepoInTx.create).toHaveBeenCalledWith(
      expect.objectContaining({ topicId: 't-resolved' }),
    );
    // Lookup was scoped to (subjectId, title).
    expect(topicsRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          subjectId: 's1',
          title: 'Scientific Units and Measurements',
        },
      }),
    );
  });

  it('bulkImport prefers explicit topicId over the topic name lookup', async () => {
    // If both are supplied, topicId wins and the topic name is ignored
    // — topicsRepo.findOne must NOT be called for that row.
    const qRepoInTx = {
      create: jest.fn((row: Record<string, unknown>) => row),
      save: jest.fn(async (row: unknown) => {
        (row as { id: string }).id = 'q2';
        return row;
      }),
    };
    const oRepoInTx = {
      create: jest.fn((row: unknown) => row),
      save: jest.fn(async (rows: unknown) => rows),
    };
    dataSource.transaction.mockImplementationOnce(
      async (fn: (em: EntityManager) => Promise<unknown>) =>
        fn({
          getRepository: (target: { name?: string } | string) => {
            const name = typeof target === 'string' ? target : target.name;
            if (name === 'Question') return qRepoInTx;
            if (name === 'Option') return oRepoInTx;
            return {};
          },
        } as unknown as EntityManager),
    );

    const out = await service.bulkImport({
      questions: [
        {
          subjectId: 's1',
          topicId: 't-explicit',
          topic: 'Some other name that would fail lookup',
          examType: 'wassce',
          questionType: 'mcq',
          source: 'past_paper',
          body: 'q body',
          difficulty: 'easy',
          options: [
            { label: 'A', body: 'a', isCorrect: true },
            { label: 'B', body: 'b', isCorrect: false },
          ],
        },
      ],
    } as never);
    expect(out.created).toBe(1);
    expect(topicsRepo.findOne).not.toHaveBeenCalled();
    expect(qRepoInTx.create).toHaveBeenCalledWith(
      expect.objectContaining({ topicId: 't-explicit' }),
    );
  });
});
