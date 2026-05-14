import {
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ExamsService } from './exams.service';
import { Exam } from './entities/exam.entity';
import { ExamAnswer } from './entities/exam-answer.entity';
import { Question } from '../questions/entities/question.entity';
import { Option } from '../questions/entities/option.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { UserSubjectProgress } from '../progress/entities/user-subject-progress.entity';
import { User } from '../users/entities/user.entity';
import { SrsService } from '../srs/srs.service';
import { GamificationService } from '../gamification/gamification.service';
import { StreakService } from '../gamification/streak.service';
import { ReferralsService } from '../referrals/referrals.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { ExamStatus, ExamMode } from '../../common/types/enums';

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
  let examsRepo: { findOne: jest.Mock };
  let answersRepo: { find: jest.Mock };
  let questionsRepo: { find: jest.Mock };
  let subscriptions: { hasActiveSubscription: jest.Mock };

  beforeEach(async () => {
    examsRepo = { findOne: jest.fn() };
    answersRepo = { find: jest.fn() };
    questionsRepo = { find: jest.fn() };
    subscriptions = {
      hasActiveSubscription: jest.fn().mockResolvedValue(false),
    };

    const noop = {} as never;

    const moduleRef = await Test.createTestingModule({
      providers: [
        ExamsService,
        { provide: getRepositoryToken(Exam), useValue: examsRepo },
        { provide: getRepositoryToken(ExamAnswer), useValue: answersRepo },
        { provide: getRepositoryToken(Question), useValue: questionsRepo },
        { provide: getRepositoryToken(Option), useValue: noop },
        { provide: getRepositoryToken(Subject), useValue: noop },
        {
          provide: getRepositoryToken(UserSubjectProgress),
          useValue: noop,
        },
        { provide: getRepositoryToken(User), useValue: noop },
        { provide: SrsService, useValue: noop },
        { provide: GamificationService, useValue: noop },
        { provide: StreakService, useValue: noop },
        { provide: ReferralsService, useValue: noop },
        { provide: SubscriptionsService, useValue: subscriptions },
        { provide: DataSource, useValue: noop },
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
});
