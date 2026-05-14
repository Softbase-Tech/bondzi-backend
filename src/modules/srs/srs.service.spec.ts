import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SrsService } from './srs.service';
import { SrsCard } from './entities/srs-card.entity';
import { Question } from '../questions/entities/question.entity';
import { RedisService } from '../../common/redis/redis.service';

/**
 * SrsService specs. Three things to guard:
 *   1. getDue returns the envelope shape the mobile validator expects
 *      ({ questionId, question, dueAt, interval, easeFactor }), not a flat
 *      StudentQuestion[]. The mobile drops everything otherwise.
 *   2. review() upserts via sm2 and invalidates the stats cache so the
 *      home-screen counter and the queue can't drift.
 *   3. stats() returns the four fields the mobile expects and treats a
 *      stale cache key as a write-after-miss.
 */

function makeQuestion(id = 'q1') {
  return {
    id,
    body: 'What is 2+2?',
    questionType: 'mcq',
    examType: 'wassce',
    status: 'active',
    difficulty: 'easy',
    options: [
      { id: 'o1', label: 'A', body: '3', isCorrect: false, sortOrder: 0 },
      { id: 'o2', label: 'B', body: '4', isCorrect: true, sortOrder: 1 },
    ],
    subjectId: 'subj-1',
    topicId: null,
    stimulusId: null,
    stimulus: null,
    year: 2024,
    wassecPaper: 1,
    section: null,
    tags: [],
    isVerified: true,
    flagCount: 0,
    timesAnswered: 0,
    timesCorrect: 0,
    explanation: null,
    explanationHtml: null,
    explanationModel: null,
    explanationGeneratedAt: null,
    imageUrl: null,
    bodyHtml: null,
    source: 'past_paper',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Question;
}

function makeCard(overrides: Partial<SrsCard> = {}): SrsCard {
  return {
    id: 'card-1',
    userId: 'user-1',
    questionId: 'q1',
    questionPool: 'past_paper',
    easeFactor: 2.5,
    intervalDays: 1,
    repetitions: 0,
    lastQuality: null,
    nextReviewAt: new Date('2026-05-13T00:00:00Z'),
    lastReviewedAt: null,
    question: makeQuestion(),
    ...overrides,
  } as SrsCard;
}

describe('SrsService', () => {
  let service: SrsService;
  let cardsRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let questionsRepo: { findOne: jest.Mock };
  let redis: { get: jest.Mock; setJson: jest.Mock; del: jest.Mock };

  beforeEach(async () => {
    cardsRepo = {
      findOne: jest.fn(),
      // Return a clone with sensible defaults so the entity has the fields
      // sm2 reads (easeFactor / intervalDays / repetitions). Also ensures
      // `toHaveBeenCalledWith` matches against the unmutated input below.
      create: jest.fn((o) => ({
        easeFactor: 2.5,
        intervalDays: 1,
        repetitions: 0,
        lastQuality: null,
        ...o,
      })),
      save: jest.fn(async (c) => c),
      count: jest.fn(async () => 0),
      createQueryBuilder: jest.fn(),
    };
    questionsRepo = { findOne: jest.fn() };
    redis = {
      get: jest.fn(),
      setJson: jest.fn(),
      del: jest.fn(),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        SrsService,
        { provide: getRepositoryToken(SrsCard), useValue: cardsRepo },
        { provide: getRepositoryToken(Question), useValue: questionsRepo },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();
    service = moduleRef.get(SrsService);
  });

  // ---------------------------- getDue ----------------------------

  describe('getDue', () => {
    function stubQbReturns(cards: SrsCard[]) {
      const qb = {
        innerJoinAndSelect: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(cards),
      };
      cardsRepo.createQueryBuilder.mockReturnValue(qb);
      return qb;
    }

    it('returns the envelope shape the mobile validator expects', async () => {
      stubQbReturns([makeCard()]);
      const out = await service.getDue('user-1');
      expect(out).toHaveLength(1);
      expect(out[0]).toEqual(
        expect.objectContaining({
          questionId: 'q1',
          dueAt: expect.any(String),
          interval: expect.any(Number),
          easeFactor: expect.any(Number),
        }),
      );
      // The mobile validator looks for `question.options.map(...)` — the
      // serializer must keep it populated.
      expect(out[0].question.options).toBeDefined();
      expect(Array.isArray(out[0].question.options)).toBe(true);
    });

    it('filters by subjectId when provided', async () => {
      const qb = stubQbReturns([]);
      await service.getDue('user-1', 'subj-1');
      expect(qb.andWhere).toHaveBeenCalledWith(
        'q.subjectId = :sid',
        { sid: 'subj-1' },
      );
    });

    it('uses an end-of-day window so it agrees with stats.dueToday', async () => {
      const qb = stubQbReturns([]);
      await service.getDue('user-1');
      const endOfDayCall = qb.andWhere.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('nextReviewAt <='),
      );
      expect(endOfDayCall).toBeDefined();
      const params = endOfDayCall![1] as { endOfToday: Date };
      // The window must end at 23:59:59.999 of "today" so the queue and the
      // counter use the same cut-off.
      expect(params.endOfToday.getHours()).toBe(23);
      expect(params.endOfToday.getMinutes()).toBe(59);
    });
  });

  // ---------------------------- review ----------------------------

  describe('review', () => {
    it('creates a card on first review and invalidates the stats cache', async () => {
      cardsRepo.findOne.mockResolvedValueOnce(null);
      questionsRepo.findOne.mockResolvedValueOnce(makeQuestion());
      await service.review('user-1', 'q1', 4);
      expect(cardsRepo.create).toHaveBeenCalledWith({
        userId: 'user-1',
        questionId: 'q1',
      });
      expect(cardsRepo.save).toHaveBeenCalled();
      expect(redis.del).toHaveBeenCalled();
    });

    it('throws NotFoundException when the question does not exist', async () => {
      cardsRepo.findOne.mockResolvedValueOnce(null);
      questionsRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.review('user-1', 'missing', 4),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('promotes an existing card via sm2 and persists the new schedule', async () => {
      const existing = makeCard({
        easeFactor: 2.5,
        intervalDays: 1,
        repetitions: 1,
      });
      cardsRepo.findOne.mockResolvedValueOnce(existing);
      await service.review('user-1', 'q1', 5);
      const saved = cardsRepo.save.mock.calls[0][0] as SrsCard;
      // sm2 with quality 5 on a card with reps=1 raises repetitions, picks a
      // larger interval, and bumps easeFactor.
      expect(saved.repetitions).toBeGreaterThan(1);
      expect(saved.intervalDays).toBeGreaterThan(1);
      expect(saved.easeFactor).toBeGreaterThanOrEqual(2.5);
    });
  });

  // ----------------------- upsertFromAnswer -----------------------

  describe('upsertFromAnswer', () => {
    it('maps a correct answer to quality 4 and a wrong answer to quality 1', async () => {
      const spy = jest.spyOn(service, 'review').mockResolvedValue({} as SrsCard);
      await service.upsertFromAnswer('user-1', 'q1', true);
      await service.upsertFromAnswer('user-1', 'q1', false);
      expect(spy.mock.calls[0]).toEqual(['user-1', 'q1', 4]);
      expect(spy.mock.calls[1]).toEqual(['user-1', 'q1', 1]);
    });
  });

  // ------------------------------ stats ------------------------------

  describe('stats', () => {
    it('returns the four counters the mobile reads', async () => {
      redis.get.mockResolvedValueOnce(null);
      cardsRepo.count
        .mockResolvedValueOnce(10) // total
        .mockResolvedValueOnce(9) // dueToday
        .mockResolvedValueOnce(2); // overdue
      // The mastered count uses a separate qb path — stub it.
      const masteredQb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(3),
      };
      cardsRepo.createQueryBuilder.mockReturnValue(masteredQb);

      const out = await service.stats('user-1');
      expect(out).toEqual({
        total: 10,
        dueToday: 9,
        overdue: 2,
        mastered: 3,
      });
    });

    it('writes the dueToday count to Redis when the cache is empty', async () => {
      redis.get.mockResolvedValueOnce(null);
      cardsRepo.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);
      cardsRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      });
      await service.stats('user-1');
      expect(redis.setJson).toHaveBeenCalled();
    });
  });
});
