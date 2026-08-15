import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ExamsService } from './exams.service';
import { Exam } from './entities/exam.entity';
import { ExamAnswer } from './entities/exam-answer.entity';
import { Question } from '../questions/entities/question.entity';
import { Option } from '../questions/entities/option.entity';
import { PmTestQuestion } from '../pm-test/entities/pm-test-question.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { UserSubjectProgress } from '../progress/entities/user-subject-progress.entity';
import { User } from '../users/entities/user.entity';
import { SrsService } from '../srs/srs.service';
import { GamificationService } from '../gamification/gamification.service';
import { StreakService } from '../gamification/streak.service';
import { PartnerCommissionsService } from '../partners/partner-commissions.service';
import { WeaknessNarrativeService } from '../progress/weakness-narrative.service';
import { ReferralsService } from '../referrals/referrals.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { AiService } from '../ai/ai.service';
import { ConfigService } from '@nestjs/config';
import { ExamStatus, ExamMode, QuestionPool } from '../../common/types/enums';

/**
 * Coverage targets for ExamsService — only the two methods that were
 * recently bug-fixed (and that the mobile depends on for resume):
 *
 *  - getOne: ownership check (Forbidden), missing exam (NotFound), and
 *    the response shape (questionCount comes from the original total,
 *    questions[] is only the *unanswered* tail).
 *  - resumeMostRecent: null when no in-progress exam, otherwise delegates
 *    to getOne so the wire shape stays consistent with the resume client.
 *
 * Other methods (create / answer / complete / history) own complex SQL
 * + transaction paths; they're covered by e2e tests, not unit tests here.
 */

function makeExam(overrides: Partial<Exam> = {}): Exam {
  return {
    id: 'exam-1',
    userId: 'user-1',
    examType: 'wassce',
    mode: ExamMode.PRACTICE,
    status: ExamStatus.IN_PROGRESS,
    subjectFilter: { subjectIds: ['subj-1'] },
    questionIds: ['q1', 'q2', 'q3', 'q4', 'q5'],
    durationSeconds: 3600,
    totalQuestions: 5,
    score: null,
    percentScore: null,
    xpEarned: 0,
    startedAt: new Date('2026-05-13T08:00:00Z'),
    completedAt: null,
    ...overrides,
  } as unknown as Exam;
}

function makeQuestion(id: string): Question {
  return {
    id,
    body: `Question ${id}`,
    questionType: 'mcq',
    examType: 'wassce',
    status: 'active',
    difficulty: 'easy',
    options: [
      {
        id: `${id}-A`,
        label: 'A',
        body: 'Option A',
        isCorrect: false,
        sortOrder: 0,
      },
      {
        id: `${id}-B`,
        label: 'B',
        body: 'Option B',
        isCorrect: true,
        sortOrder: 1,
      },
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

describe('ExamsService', () => {
  let service: ExamsService;
  let examsRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  let answersRepo: { find: jest.Mock };
  let questionsRepo: { find: jest.Mock };
  let pmTestQRepo: {
    createQueryBuilder: jest.Mock;
    find: jest.Mock;
  };
  let usersRepo: { findOne: jest.Mock };
  let subscriptions: {
    hasEntitlement: jest.Mock;
    assertCanStudySubjects: jest.Mock;
  };
  let entitlements: { assertAndConsume: jest.Mock };
  let subjectsRepo: { find: jest.Mock };

  beforeEach(async () => {
    examsRepo = {
      findOne: jest.fn(),
      create: jest.fn((row: unknown) => row),
      save: jest.fn(async (row: unknown) => ({
        id: 'exam-new',
        ...(row as object),
      })),
    };
    answersRepo = { find: jest.fn() };
    questionsRepo = { find: jest.fn() };
    pmTestQRepo = {
      createQueryBuilder: jest.fn(),
      find: jest.fn(),
    };
    usersRepo = { findOne: jest.fn() };
    subscriptions = {
      hasEntitlement: jest.fn().mockResolvedValue(false),
      assertCanStudySubjects: jest.fn().mockResolvedValue(undefined),
    };
    entitlements = {
      // Default: entitlement passes. Individual pm_test tests can override
      // to simulate 429/403.
      assertAndConsume: jest
        .fn()
        .mockResolvedValue({ policy: {}, usedCount: 1 }),
    };
    subjectsRepo = { find: jest.fn().mockResolvedValue([]) };

    const noop = {} as never;

    const moduleRef = await Test.createTestingModule({
      providers: [
        ExamsService,
        { provide: getRepositoryToken(Exam), useValue: examsRepo },
        { provide: getRepositoryToken(ExamAnswer), useValue: answersRepo },
        { provide: getRepositoryToken(Question), useValue: questionsRepo },
        { provide: getRepositoryToken(Option), useValue: noop },
        { provide: getRepositoryToken(PmTestQuestion), useValue: pmTestQRepo },
        { provide: getRepositoryToken(Subject), useValue: subjectsRepo },
        {
          provide: getRepositoryToken(UserSubjectProgress),
          useValue: noop,
        },
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: SrsService, useValue: noop },
        { provide: GamificationService, useValue: noop },
        { provide: StreakService, useValue: noop },
        { provide: ReferralsService, useValue: noop },
        { provide: SubscriptionsService, useValue: subscriptions },
        { provide: EntitlementsService, useValue: entitlements },
        { provide: AiService, useValue: { callBedrock: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: DataSource, useValue: noop },
        {
          provide: PartnerCommissionsService,
          useValue: {
            tickSignupProgress: jest.fn().mockResolvedValue(undefined),
            tickAnswersBonus: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: WeaknessNarrativeService,
          useValue: {
            invalidateBootstrapForToday: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(ExamsService);
  });

  // ---------------------------- getOne ----------------------------

  describe('getOne', () => {
    it('throws NotFoundException when the exam does not exist', async () => {
      examsRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.getOne('user-1', 'missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws ForbiddenException when the exam belongs to another user', async () => {
      examsRepo.findOne.mockResolvedValueOnce(
        makeExam({ userId: 'someone-else' }),
      );
      await expect(service.getOne('user-1', 'exam-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('returns only unanswered questions but keeps questionCount at the original total', async () => {
      // exam has 5 question ids; user has already answered 2.
      examsRepo.findOne.mockResolvedValueOnce(makeExam());
      answersRepo.find.mockResolvedValueOnce([
        { questionId: 'q1' },
        { questionId: 'q2' },
      ]);
      // Only the 3 unanswered come back from the questions repo.
      questionsRepo.find.mockResolvedValueOnce([
        makeQuestion('q3'),
        makeQuestion('q4'),
        makeQuestion('q5'),
      ]);

      const out = await service.getOne('user-1', 'exam-1');

      expect(out.questionCount).toBe(5); // original total, NOT array length
      expect(out.questions).toHaveLength(3);
      expect(out.questions.map((q) => q.id)).toEqual(['q3', 'q4', 'q5']);
    });

    it('returns an empty questions[] when every question has been answered', async () => {
      examsRepo.findOne.mockResolvedValueOnce(makeExam());
      answersRepo.find.mockResolvedValueOnce([
        { questionId: 'q1' },
        { questionId: 'q2' },
        { questionId: 'q3' },
        { questionId: 'q4' },
        { questionId: 'q5' },
      ]);
      // The service should not even call the questions repo when remaining
      // is empty — verifies the small optimisation in the implementation.

      const out = await service.getOne('user-1', 'exam-1');

      expect(out.questions).toEqual([]);
      expect(questionsRepo.find).not.toHaveBeenCalled();
    });
  });

  // ----------------------- resumeMostRecent -----------------------

  describe('resumeMostRecent', () => {
    it('returns null when the user has no in-progress exam', async () => {
      examsRepo.findOne.mockResolvedValueOnce(null);
      const out = await service.resumeMostRecent('user-1');
      expect(out).toBeNull();
    });

    // ------------------------- create (pm_test) -------------------------
    // The pm_test branch was added in Phase 1.2 to route level-test sessions
    // to the AI-generated `pm_test_questions` pool with a syllabus_topic_id
    // filter — separate from the past-paper `questions` path.

    it('delegates to getOne when there is an in-progress exam', async () => {
      // findOne is called twice — once to discover the in-progress exam,
      // then again from inside getOne to load the same exam.
      const exam = makeExam();
      examsRepo.findOne
        .mockResolvedValueOnce(exam) // resumeMostRecent's findOne
        .mockResolvedValueOnce(exam); // getOne's findOne
      answersRepo.find.mockResolvedValueOnce([]);
      questionsRepo.find.mockResolvedValueOnce([
        makeQuestion('q1'),
        makeQuestion('q2'),
        makeQuestion('q3'),
        makeQuestion('q4'),
        makeQuestion('q5'),
      ]);

      const out = await service.resumeMostRecent('user-1');

      expect(out).not.toBeNull();
      expect(out!.id).toBe('exam-1');
      expect(out!.questionCount).toBe(5);
      expect(out!.questions).toHaveLength(5);
    });
  });

  // ------------------------- create (pm_test) -------------------------
  describe('create → pm_test branch', () => {
    function stubPmTestIdsQb(rows: Array<{ id: string }>): {
      andWhere: jest.Mock;
      orderBy: jest.Mock;
    } {
      const andWhere = jest.fn().mockReturnThis();
      const orderBy = jest.fn().mockReturnThis();
      const qb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere,
        orderBy,
        limit: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(rows),
      };
      pmTestQRepo.createQueryBuilder.mockReturnValueOnce(qb);
      return { andWhere, orderBy };
    }

    function makePmTestQuestion(id: string) {
      return {
        id,
        subjectId: 'subj-1',
        syllabusTopicId: 'stopic-1',
        formLevel: 2,
        examType: 'wassce',
        questionType: 'mcq',
        body: `PM Q ${id}`,
        explanation: 'why',
        difficulty: 'medium',
        status: 'active',
        options: [
          { id: `${id}-a`, label: 'A', body: 'a', isCorrect: false },
          { id: `${id}-b`, label: 'B', body: 'b', isCorrect: true },
        ],
      };
    }

    it('rejects syllabusTopicIds when mode is not pm_test', async () => {
      usersRepo.findOne.mockResolvedValueOnce({
        id: 'user-1',
        examType: 'wassce',
        formLevel: 2,
      });
      await expect(
        service.create('user-1', {
          mode: ExamMode.PRACTICE,
          subjectFilter: {
            subjectIds: ['subj-1'],
            syllabusTopicIds: ['stopic-1'],
          },
        }),
      ).rejects.toThrow(/syllabusTopicIds/);
      expect(pmTestQRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('rejects past-paper filters when mode is pm_test', async () => {
      usersRepo.findOne.mockResolvedValueOnce({
        id: 'user-1',
        examType: 'wassce',
        formLevel: 2,
      });
      await expect(
        service.create('user-1', {
          mode: ExamMode.PM_TEST,
          subjectFilter: { subjectIds: ['subj-1'], topicIds: ['past-t-1'] },
        }),
      ).rejects.toThrow(/topicIds/);
      expect(pmTestQRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('rejects year/wassecPaper on pm_test mode', async () => {
      usersRepo.findOne.mockResolvedValueOnce({
        id: 'user-1',
        examType: 'wassce',
        formLevel: 2,
      });
      await expect(
        service.create('user-1', {
          mode: ExamMode.PM_TEST,
          subjectFilter: { subjectIds: ['subj-1'], years: [2019] },
        }),
      ).rejects.toThrow(/past-paper/);
    });

    it('400s when no pm_test questions match the filter', async () => {
      usersRepo.findOne.mockResolvedValueOnce({
        id: 'user-1',
        examType: 'wassce',
        formLevel: 2,
      });
      stubPmTestIdsQb([]);
      await expect(
        service.create('user-1', {
          mode: ExamMode.PM_TEST,
          subjectFilter: { subjectIds: ['subj-1'] },
        }),
      ).rejects.toThrow(/level-test/);
    });

    it('creates a session with QuestionPool.PM_TEST and pm-test wire shape', async () => {
      usersRepo.findOne.mockResolvedValueOnce({
        id: 'user-1',
        examType: 'wassce',
        formLevel: 2,
      });
      const { andWhere } = stubPmTestIdsQb([{ id: 'p1' }, { id: 'p2' }]);
      pmTestQRepo.find.mockResolvedValueOnce([
        makePmTestQuestion('p1'),
        makePmTestQuestion('p2'),
      ]);
      subscriptions.hasEntitlement.mockResolvedValueOnce(true);

      const out = await service.create('user-1', {
        mode: ExamMode.PM_TEST,
        subjectFilter: {
          subjectIds: ['subj-1'],
          syllabusTopicIds: ['stopic-1'],
        },
        questionCount: 20,
      });

      // Persisted exam row uses PM_TEST question pool so the answer path
      // routes to pm_test_options for grading.
      const savedExam = examsRepo.save.mock.calls[0][0];
      expect(savedExam.questionPool).toBe(QuestionPool.PM_TEST);
      expect(savedExam.mode).toBe(ExamMode.PM_TEST);

      // The filter is applied — subject_id, syllabus_topic_id, form_level.
      const whereCalls = andWhere.mock.calls.map((c) => c[0]);
      expect(whereCalls.some((s) => /subject_id IN/.test(s))).toBe(true);
      expect(whereCalls.some((s) => /syllabus_topic_id IN/.test(s))).toBe(true);
      expect(whereCalls.some((s) => /form_level/.test(s))).toBe(true);

      // Wire shape: StudentQuestion (past-paper) — year/paper null, source
      // tagged, options carried through, isCorrect stripped.
      expect(out.questions).toHaveLength(2);
      expect(out.questions[0].year).toBeNull();
      expect(out.questions[0].paper).toBeNull();
      expect(out.questions[0].source).toBe('ai_pm_test');
      expect(out.questions[0].options.every((o) => !('isCorrect' in o))).toBe(
        true,
      );
      // Subscribed user sees explanation inline.
      expect(out.questions[0].explanation).toContain('why');
    });

    it('consumes the LEVEL_TESTS entitlement before touching the DB', async () => {
      usersRepo.findOne.mockResolvedValueOnce({
        id: 'user-1',
        examType: 'wassce',
        formLevel: 2,
      });
      stubPmTestIdsQb([{ id: 'p1' }]);
      pmTestQRepo.find.mockResolvedValueOnce([makePmTestQuestion('p1')]);

      await service.create('user-1', {
        mode: ExamMode.PM_TEST,
        subjectFilter: { subjectIds: ['subj-1'] },
      });

      expect(entitlements.assertAndConsume).toHaveBeenCalledTimes(1);
      const [uid, svc] = entitlements.assertAndConsume.mock.calls[0];
      expect(uid).toBe('user-1');
      expect(svc).toBe('level_tests');
      // Session save fires AFTER entitlement consume, not before.
      const consumeOrder =
        entitlements.assertAndConsume.mock.invocationCallOrder[0];
      const saveOrder = examsRepo.save.mock.invocationCallOrder[0];
      expect(consumeOrder).toBeLessThan(saveOrder);
    });

    it('surfaces the entitlement 429 without creating a session', async () => {
      usersRepo.findOne.mockResolvedValueOnce({
        id: 'user-1',
        examType: 'wassce',
        formLevel: 2,
      });
      const quota429 = Object.assign(new Error('429'), {
        status: 429,
        response: {
          statusCode: 429,
          message: 'daily limit',
        },
      });
      entitlements.assertAndConsume.mockRejectedValueOnce(quota429);

      await expect(
        service.create('user-1', {
          mode: ExamMode.PM_TEST,
          subjectFilter: { subjectIds: ['subj-1'] },
        }),
      ).rejects.toBe(quota429);
      expect(pmTestQRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(examsRepo.save).not.toHaveBeenCalled();
    });

    it('honours the difficulty filter when set to something other than mixed', async () => {
      usersRepo.findOne.mockResolvedValueOnce({
        id: 'user-1',
        examType: 'wassce',
        formLevel: 2,
      });
      const { andWhere } = stubPmTestIdsQb([{ id: 'p1' }]);
      pmTestQRepo.find.mockResolvedValueOnce([makePmTestQuestion('p1')]);

      await service.create('user-1', {
        mode: ExamMode.PM_TEST,
        subjectFilter: { subjectIds: ['subj-1'] },

        difficulty: 'hard' as any,
      });

      const whereCalls = andWhere.mock.calls.map((c) => c[0]);
      expect(whereCalls.some((s) => /q\.difficulty/.test(s))).toBe(true);
    });

    it('skips the form_level filter for NOVDEC users (formLevel=null)', async () => {
      usersRepo.findOne.mockResolvedValueOnce({
        id: 'user-1',
        examType: 'novdec',
        formLevel: null,
      });
      const { andWhere } = stubPmTestIdsQb([{ id: 'p1' }]);
      pmTestQRepo.find.mockResolvedValueOnce([makePmTestQuestion('p1')]);

      await service.create('user-1', {
        mode: ExamMode.PM_TEST,
        subjectFilter: { subjectIds: ['subj-1'] },
      });

      const whereCalls = andWhere.mock.calls.map((c) => c[0]);
      expect(whereCalls.some((s) => /form_level/.test(s))).toBe(false);
    });
  });

  // ------------------------- create (past_paper metering) -------------------------
  describe('create → past_paper metering', () => {
    function stubPastPaperIdsQb(rows: Array<{ id: string }>): void {
      const qb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(rows),
      };
      questionsRepo.find = jest.fn().mockResolvedValue([]);
      (
        service as unknown as {
          questionsRepo: { createQueryBuilder: jest.Mock };
        }
      ).questionsRepo = {
        createQueryBuilder: jest.fn().mockReturnValueOnce(qb),
      };
    }

    it('meters PAST_PAPERS_CORE when the subject is core', async () => {
      usersRepo.findOne.mockResolvedValueOnce({
        id: 'user-1',
        examType: 'wassce',
        formLevel: 2,
      });
      subjectsRepo.find.mockResolvedValueOnce([
        { id: 'subj-1', category: 'core' },
      ]);
      stubPastPaperIdsQb([]);
      // No question matches → the past-paper branch throws BadRequest,
      // but that's after the entitlement consume — which is what we assert.
      await service
        .create('user-1', {
          mode: ExamMode.PAST_PAPER,
          subjectFilter: { subjectIds: ['subj-1'] },
        })
        .catch(() => undefined);
      expect(entitlements.assertAndConsume).toHaveBeenCalledWith(
        'user-1',
        'past_papers_core',
      );
    });

    it('meters PAST_PAPERS_ELECTIVE when the subject is elective', async () => {
      usersRepo.findOne.mockResolvedValueOnce({
        id: 'user-1',
        examType: 'wassce',
        formLevel: 2,
      });
      subjectsRepo.find.mockResolvedValueOnce([
        { id: 'subj-1', category: 'elective' },
      ]);
      stubPastPaperIdsQb([]);
      await service
        .create('user-1', {
          mode: ExamMode.PAST_PAPER,
          subjectFilter: { subjectIds: ['subj-1'] },
        })
        .catch(() => undefined);
      expect(entitlements.assertAndConsume).toHaveBeenCalledWith(
        'user-1',
        'past_papers_elective',
      );
    });

    it('meters ELECTIVE when the batch mixes core + elective (conservative)', async () => {
      usersRepo.findOne.mockResolvedValueOnce({
        id: 'user-1',
        examType: 'wassce',
        formLevel: 2,
      });
      subjectsRepo.find.mockResolvedValueOnce([
        { id: 'a', category: 'core' },
        { id: 'b', category: 'elective' },
      ]);
      stubPastPaperIdsQb([]);
      await service
        .create('user-1', {
          mode: ExamMode.PAST_PAPER,
          subjectFilter: { subjectIds: ['a', 'b'] },
        })
        .catch(() => undefined);
      expect(entitlements.assertAndConsume).toHaveBeenCalledWith(
        'user-1',
        'past_papers_elective',
      );
    });

    it('mock-exam mode meters MOCK_EXAMS and refuses topic/year filters', async () => {
      usersRepo.findOne.mockResolvedValueOnce({
        id: 'user-1',
        examType: 'wassce',
        formLevel: 2,
      });
      await expect(
        service.create('user-1', {
          mode: ExamMode.MOCK_EXAM,
          subjectFilter: {
            subjectIds: ['subj-1'],
            years: [2019],
          },
        }),
      ).rejects.toThrow(/mock/i);
      expect(entitlements.assertAndConsume).not.toHaveBeenCalled();
    });

    it('mock-exam requires exactly one subjectId', async () => {
      usersRepo.findOne.mockResolvedValueOnce({
        id: 'user-1',
        examType: 'wassce',
        formLevel: 2,
      });
      await expect(
        service.create('user-1', {
          mode: ExamMode.MOCK_EXAM,
          subjectFilter: { subjectIds: ['a', 'b'] },
        }),
      ).rejects.toThrow(/single-subject/i);
    });

    it('mock-exam meters against MOCK_EXAMS, not past-paper keys', async () => {
      usersRepo.findOne.mockResolvedValueOnce({
        id: 'user-1',
        examType: 'wassce',
        formLevel: 2,
      });
      // Stub question-id query returning empty so the branch throws
      // after entitlement consume — we're asserting the meter, not
      // the session-save path here.
      stubPastPaperIdsQb([]);
      await service
        .create('user-1', {
          mode: ExamMode.MOCK_EXAM,
          subjectFilter: { subjectIds: ['subj-1'] },
        })
        .catch(() => undefined);
      expect(entitlements.assertAndConsume).toHaveBeenCalledWith(
        'user-1',
        'mock_exams',
      );
    });

    it('surfaces 429 without hitting the question-id query', async () => {
      usersRepo.findOne.mockResolvedValueOnce({
        id: 'user-1',
        examType: 'wassce',
        formLevel: 2,
      });
      subjectsRepo.find.mockResolvedValueOnce([
        { id: 'subj-1', category: 'elective' },
      ]);
      const q429 = Object.assign(new Error('429'), {
        status: 429,
        response: { statusCode: 429 },
      });
      entitlements.assertAndConsume.mockRejectedValueOnce(q429);
      // Spy on createQueryBuilder to assert it was never called.
      const cqb = jest.fn();
      (
        service as unknown as {
          questionsRepo: { createQueryBuilder: jest.Mock };
        }
      ).questionsRepo = { createQueryBuilder: cqb };

      await expect(
        service.create('user-1', {
          mode: ExamMode.PAST_PAPER,
          subjectFilter: { subjectIds: ['subj-1'] },
        }),
      ).rejects.toBe(q429);
      expect(cqb).not.toHaveBeenCalled();
    });
  });
});
