import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PmTestService } from './pm-test.service';
import { PmTestQuestion } from './entities/pm-test-question.entity';
import { PmTestOption } from './entities/pm-test-option.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { User } from '../users/entities/user.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import { ExamType, QuestionStatus } from '../../common/types/enums';

/**
 * PmTestService coverage:
 *   - listSubjectsForUser uses the *user's* examType/formLevel (not the DTO)
 *     so an admin spoofing another level on the mobile picker doesn't leak.
 *   - listQuestions filters by ACTIVE only, defaults limit to 20, clamps to
 *     [1,100], throws BadRequest on empty result.
 *   - statsForUser parses string SUM/COUNT to numbers and computes accuracy.
 */

describe('PmTestService', () => {
  let service: PmTestService;
  let qRepo: { createQueryBuilder: jest.Mock };
  let oRepo: Record<string, unknown>;
  let subjectsRepo: Record<string, unknown>;
  let usersRepo: { findOne: jest.Mock };
  let answersRepo: { createQueryBuilder: jest.Mock };

  function stubSubjectsQb(rows: unknown[]) {
    const qb = {
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rows),
    };
    qRepo.createQueryBuilder.mockReturnValueOnce(qb);
    return qb;
  }
  function stubAnswersQb(rows: unknown[]) {
    const qb = {
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rows),
    };
    answersRepo.createQueryBuilder.mockReturnValueOnce(qb);
    return qb;
  }
  function stubQuestionsQb(rows: unknown[]) {
    const qb = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(rows),
    };
    qRepo.createQueryBuilder.mockReturnValueOnce(qb);
    return qb;
  }

  beforeEach(async () => {
    qRepo = { createQueryBuilder: jest.fn() };
    oRepo = {};
    subjectsRepo = {};
    usersRepo = { findOne: jest.fn() };
    answersRepo = { createQueryBuilder: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PmTestService,
        { provide: getRepositoryToken(PmTestQuestion), useValue: qRepo },
        { provide: getRepositoryToken(PmTestOption), useValue: oRepo },
        { provide: getRepositoryToken(Subject), useValue: subjectsRepo },
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: getRepositoryToken(ExamAnswer), useValue: answersRepo },
      ],
    }).compile();
    service = moduleRef.get(PmTestService);
  });

  // ------------------------ listSubjectsForUser ------------------------

  it('listSubjectsForUser throws NotFound when the user is gone', async () => {
    usersRepo.findOne.mockResolvedValueOnce(null);
    await expect(service.listSubjectsForUser('user-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("listSubjectsForUser passes the user's exam/level into the query", async () => {
    usersRepo.findOne.mockResolvedValueOnce({
      examType: ExamType.BECE,
      formLevel: 2,
    });
    const qb = stubSubjectsQb([
      { subjectId: 's-1', subjectName: 'Maths', activeQuestionCount: '12' },
    ]);
    const attemptsQb = stubAnswersQb([]);
    const out = await service.listSubjectsForUser('user-1');
    expect(qb.where).toHaveBeenCalledWith('q.exam_type = :et', {
      et: ExamType.BECE,
    });
    expect(qb.andWhere).toHaveBeenCalledWith('q.form_level = :fl', { fl: 2 });
    expect(qb.andWhere).toHaveBeenCalledWith('q.status = :st', {
      st: QuestionStatus.ACTIVE,
    });
    // attempt-stats query is invoked to merge per-subject accuracy in
    expect(attemptsQb.innerJoin).toHaveBeenCalled();
    expect(out).toEqual([
      {
        subjectId: 's-1',
        subjectName: 'Maths',
        iconSlug: null,
        activeQuestionCount: 12,
        lastAttemptedAt: null,
        accuracy: null,
      },
    ]);
  });

  it('listSubjectsForUser merges per-subject accuracy + last attempted', async () => {
    usersRepo.findOne.mockResolvedValueOnce({
      examType: ExamType.WASSCE,
      formLevel: 3,
    });
    stubSubjectsQb([
      { subjectId: 's-1', subjectName: 'Chemistry', activeQuestionCount: '42' },
      { subjectId: 's-2', subjectName: 'Physics', activeQuestionCount: '7' },
    ]);
    const attempted = new Date('2026-08-15T10:00:00.000Z');
    stubAnswersQb([
      {
        subjectId: 's-1',
        answered: '10',
        correct: '8',
        lastAttemptedAt: attempted,
      },
    ]);
    const out = await service.listSubjectsForUser('user-1');
    expect(out).toEqual([
      {
        subjectId: 's-1',
        subjectName: 'Chemistry',
        iconSlug: null,
        activeQuestionCount: 42,
        lastAttemptedAt: attempted.toISOString(),
        accuracy: 0.8,
      },
      {
        subjectId: 's-2',
        subjectName: 'Physics',
        iconSlug: null,
        activeQuestionCount: 7,
        lastAttemptedAt: null,
        accuracy: null,
      },
    ]);
  });

  // --------------------------- listQuestions ---------------------------

  it('listQuestions clamps limit to [1, 100]', async () => {
    usersRepo.findOne.mockResolvedValueOnce({
      examType: ExamType.WASSCE,
      formLevel: 3,
    });
    const qb = stubQuestionsQb([
      { id: 'q1', body: 'Q', options: [{ id: 'o1' }] },
    ]);
    await service.listQuestions('user-1', { subjectId: 's-1', limit: 999 });
    expect(qb.limit).toHaveBeenCalledWith(100);
  });

  it('listQuestions defaults limit to 20 and uses the user formLevel', async () => {
    usersRepo.findOne.mockResolvedValueOnce({
      examType: ExamType.WASSCE,
      formLevel: 3,
    });
    const qb = stubQuestionsQb([
      { id: 'q1', body: 'Q', options: [{ id: 'o1' }] },
    ]);
    await service.listQuestions('user-1', { subjectId: 's-1' });
    expect(qb.limit).toHaveBeenCalledWith(20);
    expect(qb.andWhere).toHaveBeenCalledWith('q.form_level = :fl', { fl: 3 });
  });

  it('listQuestions accepts an override formLevel for admin previews', async () => {
    usersRepo.findOne.mockResolvedValueOnce({
      examType: ExamType.WASSCE,
      formLevel: 3,
    });
    const qb = stubQuestionsQb([
      { id: 'q1', body: 'Q', options: [{ id: 'o1' }] },
    ]);
    await service.listQuestions('user-1', { subjectId: 's-1', formLevel: 1 });
    expect(qb.andWhere).toHaveBeenCalledWith('q.form_level = :fl', { fl: 1 });
  });

  it('listQuestions throws BadRequest when the pool is empty', async () => {
    usersRepo.findOne.mockResolvedValueOnce({
      examType: ExamType.WASSCE,
      formLevel: 3,
    });
    stubQuestionsQb([]);
    await expect(
      service.listQuestions('user-1', { subjectId: 's-1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ----------------------------- statsForUser -----------------------------

  it('statsForUser parses string SUM/COUNT and computes accuracy', async () => {
    const qb = {
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        {
          subjectId: 's-1',
          subjectName: 'Maths',
          answered: '20',
          correct: '15',
        },
        {
          subjectId: 's-2',
          subjectName: 'English',
          answered: '0',
          correct: '0',
        },
      ]),
    };
    answersRepo.createQueryBuilder.mockReturnValueOnce(qb);
    const out = await service.statsForUser('user-1');
    expect(out[0]).toEqual({
      subjectId: 's-1',
      subjectName: 'Maths',
      answered: 20,
      correct: 15,
      accuracy: 15 / 20,
    });
    // Defensive: zero-answered subject must not return NaN.
    expect(out[1].accuracy).toBe(0);
  });

  // ----------------------------- helpers -----------------------------

  it('correctOption returns the option with isCorrect=true', () => {
    const opts = [
      { id: 'a', isCorrect: false },
      { id: 'b', isCorrect: true },
    ] as PmTestOption[];
    expect(service.correctOption(opts)?.id).toBe('b');
  });
});
