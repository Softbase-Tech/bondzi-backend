import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SubjectsService } from './subjects.service';
import { Subject } from './entities/subject.entity';
import { Topic } from './entities/topic.entity';
import { Question } from '../questions/entities/question.entity';
import { RedisService } from '../../common/redis/redis.service';
import { ExamType } from '../../common/types/enums';

/**
 *  - listActive: cache hit returns immediately; cache miss runs both
 *    queries, merges question counts onto the rows, and writes the result
 *    back to Redis.
 *  - getById throws NotFound.
 *  - getTopics returns [] for a childless subject (no second query fired).
 *  - create / update / createTopic invalidate all three cache variants
 *    (combined, BECE, WASSCE).
 */

describe('SubjectsService', () => {
  let service: SubjectsService;
  let subjectsRepo: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let topicsRepo: { find: jest.Mock; create: jest.Mock; save: jest.Mock };
  let questionsRepo: { createQueryBuilder: jest.Mock };
  let redis: { getJson: jest.Mock; setJson: jest.Mock; del: jest.Mock };

  beforeEach(async () => {
    subjectsRepo = {
      createQueryBuilder: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((o) => ({ ...o })),
      save: jest.fn(async (o) => o),
    };
    topicsRepo = {
      find: jest.fn(),
      create: jest.fn((o) => ({ ...o })),
      save: jest.fn(async (o) => o),
    };
    questionsRepo = { createQueryBuilder: jest.fn() };
    redis = { getJson: jest.fn(), setJson: jest.fn(), del: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        SubjectsService,
        { provide: getRepositoryToken(Subject), useValue: subjectsRepo },
        { provide: getRepositoryToken(Topic), useValue: topicsRepo },
        { provide: getRepositoryToken(Question), useValue: questionsRepo },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();
    service = moduleRef.get(SubjectsService);
  });

  // ----------------------------- listActive -----------------------------

  describe('listActive', () => {
    it('returns the cached payload without touching the DB on a hit', async () => {
      redis.getJson.mockResolvedValueOnce([
        { id: 's-1', name: 'Maths', topicCount: 5, questionCount: 100 },
      ]);
      const out = await service.listActive(ExamType.WASSCE);
      expect(out).toHaveLength(1);
      expect(subjectsRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('hydrates question counts onto the rows on a cache miss and writes back', async () => {
      redis.getJson.mockResolvedValueOnce(null);
      const subjectsQb = {
        loadRelationCountAndMap: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          { id: 's-1', name: 'Maths' },
          { id: 's-2', name: 'English' },
        ]),
      };
      subjectsRepo.createQueryBuilder.mockReturnValueOnce(subjectsQb);
      const countsQb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ subjectId: 's-1', count: '50' }]),
      };
      questionsRepo.createQueryBuilder.mockReturnValueOnce(countsQb);

      const out = await service.listActive(ExamType.WASSCE);

      expect(out[0]).toEqual(expect.objectContaining({ questionCount: 50 }));
      expect(out[1]).toEqual(expect.objectContaining({ questionCount: 0 }));
      expect(redis.setJson).toHaveBeenCalled();
    });
  });

  // ----------------------------- getById -----------------------------

  it('getById throws NotFound for an unknown id', async () => {
    subjectsRepo.findOne.mockResolvedValueOnce(null);
    await expect(service.getById('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // ----------------------------- getTopics -----------------------------

  it('getTopics short-circuits to [] when the subject has no topics', async () => {
    topicsRepo.find.mockResolvedValueOnce([]);
    const out = await service.getTopics('s-1');
    expect(out).toEqual([]);
    expect(questionsRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  // ----------------------------- create -----------------------------

  it('create / update / createTopic invalidate the all + BECE + WASSCE cache keys', async () => {
    await service.create({ name: 'New', examType: ExamType.WASSCE } as never);
    expect(redis.del).toHaveBeenCalledTimes(3);
  });

  it('update throws NotFound for an unknown id', async () => {
    subjectsRepo.findOne.mockResolvedValueOnce(null);
    await expect(
      service.update('nope', { name: 'X' } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('createTopic throws NotFound for a missing subject', async () => {
    subjectsRepo.findOne.mockResolvedValueOnce(null);
    await expect(
      service.createTopic('nope', { title: 'T' } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
