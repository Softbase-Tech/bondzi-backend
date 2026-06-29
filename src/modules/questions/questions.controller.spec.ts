import { Test } from '@nestjs/testing';
import { QuestionsController } from './questions.controller';
import { QuestionsService } from './questions.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { ExamType, UserRole } from '../../common/types/enums';

/**
 * QuestionsController is the security gate on the explanation paywall. The
 * subtle thing each test pins:
 *   - list passes BOTH isAdmin AND hasActiveSubscription to the service.
 *     Admin role short-circuits the subscription check — admins always see
 *     explanations even without a sub. If this regresses, admins reading a
 *     question in the dashboard would see the gated empty explanation.
 *   - The mobile JWT carries examType; the controller must forward it as
 *     defaultExamType so list() inside the service can apply the BECE/WASSCE
 *     scoping (spec §3.1 mandates exam isolation).
 *   - getOne re-runs the same role/subscription branch — paywall must not
 *     drop on a deep link.
 */

describe('QuestionsController', () => {
  let controller: QuestionsController;
  let questions: jest.Mocked<QuestionsService>;
  let subscriptions: {
    hasEntitlement: jest.Mock;
    assertCanStudySubject: jest.Mock;
    assertCanStudySubjects: jest.Mock;
  };

  beforeEach(async () => {
    questions = {
      list: jest.fn(),
      search: jest.fn(),
      years: jest.fn(),
      getPastPaper: jest.fn(),
      getAdaptive: jest.fn(),
      getById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      bulkImport: jest.fn(),
      flag: jest.fn(),
      verify: jest.fn(),
    } as unknown as jest.Mocked<QuestionsService>;
    subscriptions = {
      hasEntitlement: jest.fn().mockResolvedValue(false),
      // assertCanStudySubject* are entitlement-gate helpers called
      // by the past-paper + adaptive endpoints. The tests in this
      // file don't assert on them — a resolved promise lets the
      // controller proceed past the gate, then assertions on the
      // downstream service mocks run as before.
      assertCanStudySubject: jest.fn().mockResolvedValue(undefined),
      assertCanStudySubjects: jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [QuestionsController],
      providers: [
        { provide: QuestionsService, useValue: questions },
        { provide: SubscriptionsService, useValue: subscriptions },
      ],
    }).compile();
    controller = moduleRef.get(QuestionsController);
  });

  it('list short-circuits the subscription check for admin callers', async () => {
    await controller.list(
      {} as never,
      { id: 'a', role: UserRole.ADMIN, examType: ExamType.WASSCE } as never,
    );
    expect(subscriptions.hasEntitlement).not.toHaveBeenCalled();
    expect(questions.list).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        isAdmin: true,
        hasActiveSubscription: true, // forced true for admin
        defaultExamType: ExamType.WASSCE,
      }),
    );
  });

  it('list forwards the JWT examType to the service as defaultExamType', async () => {
    await controller.list(
      {} as never,
      { id: 'u', role: UserRole.STUDENT, examType: ExamType.BECE } as never,
    );
    expect(questions.list).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        isAdmin: false,
        defaultExamType: ExamType.BECE,
      }),
    );
  });

  it('search parses the limit query and forwards the subscription state', async () => {
    subscriptions.hasEntitlement.mockResolvedValueOnce(true);
    await controller.search('algebra', { id: 'u' } as never, '5');
    expect(questions.search).toHaveBeenCalledWith(
      'algebra',
      { hasActiveSubscription: true },
      5,
    );
  });

  it('search defaults limit to 20 when the query is missing', async () => {
    await controller.search('algebra', { id: 'u' } as never);
    expect(questions.search).toHaveBeenLastCalledWith(
      'algebra',
      expect.any(Object),
      20,
    );
  });

  it('pastPaper falls back to wassce when the JWT has no examType', async () => {
    await controller.pastPaper(
      { subjectId: 's', year: 2024 } as never,
      { id: 'u' } as never,
    );
    expect(questions.getPastPaper).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ examType: 'wassce' }),
    );
  });

  it('getOne re-checks the admin role on a deep-link read', async () => {
    await controller.getOne('q', {
      id: 'a',
      role: UserRole.SUPERADMIN,
      examType: ExamType.WASSCE,
    } as never);
    expect(subscriptions.hasEntitlement).not.toHaveBeenCalled();
    expect(questions.getById).toHaveBeenCalledWith(
      'q',
      expect.objectContaining({ isAdmin: true, hasActiveSubscription: true }),
    );
  });

  it('flag forwards (userId, questionId, dto)', () => {
    controller.flag(
      'q-1',
      { id: 'u' } as never,
      { reason: 'wrong_answer' } as never,
    );
    expect(questions.flag).toHaveBeenCalledWith('u', 'q-1', {
      reason: 'wrong_answer',
    });
  });
});
