import { Test } from '@nestjs/testing';
import { ExamsController } from './exams.controller';
import { ExamsService } from './exams.service';

/**
 * ExamsController is a thin pass-through. Tests check that the JWT user id is
 * always paired with the route param (you can't grade another user's exam by
 * just hitting /exams/:id) and that the resume endpoint reads the JWT user.
 */

describe('ExamsController', () => {
  let controller: ExamsController;
  let exams: jest.Mocked<ExamsService>;

  beforeEach(async () => {
    exams = {
      create: jest.fn(),
      history: jest.fn(),
      resumeMostRecent: jest.fn(),
      getOne: jest.fn(),
      submitAnswer: jest.fn(),
      complete: jest.fn(),
      abandon: jest.fn(),
      getResult: jest.fn(),
    } as unknown as jest.Mocked<ExamsService>;
    const moduleRef = await Test.createTestingModule({
      controllers: [ExamsController],
      providers: [{ provide: ExamsService, useValue: exams }],
    }).compile();
    controller = moduleRef.get(ExamsController);
  });

  it('create forwards (userId, dto)', async () => {
    await controller.create(
      { id: 'u' } as never,
      { mode: 'practice' } as never,
    );
    expect(exams.create).toHaveBeenCalledWith('u', { mode: 'practice' });
  });

  it('history forwards (userId, query)', async () => {
    await controller.history({ id: 'u' } as never, { page: 1 } as never);
    expect(exams.history).toHaveBeenCalledWith('u', { page: 1 });
  });

  it('resume forwards only the userId', async () => {
    await controller.resume({ id: 'u' } as never);
    expect(exams.resumeMostRecent).toHaveBeenCalledWith('u');
  });

  it('get forwards (userId, examId) — never just the examId', async () => {
    await controller.get({ id: 'u' } as never, 'ex-1');
    expect(exams.getOne).toHaveBeenCalledWith('u', 'ex-1');
  });

  it('submitAnswer forwards (userId, examId, dto)', async () => {
    await controller.submitAnswer({ id: 'u' } as never, 'ex-1', {
      questionId: 'q',
      selectedOptionId: 'o',
      timeSpentMs: 1000,
    } as never);
    expect(exams.submitAnswer).toHaveBeenCalledWith('u', 'ex-1', {
      questionId: 'q',
      selectedOptionId: 'o',
      timeSpentMs: 1000,
    });
  });

  it('complete + abandon + result forward (userId, examId)', async () => {
    await controller.complete({ id: 'u' } as never, 'ex-1');
    await controller.abandon({ id: 'u' } as never, 'ex-1');
    await controller.result({ id: 'u' } as never, 'ex-1');
    expect(exams.complete).toHaveBeenCalledWith('u', 'ex-1');
    expect(exams.abandon).toHaveBeenCalledWith('u', 'ex-1');
    expect(exams.getResult).toHaveBeenCalledWith('u', 'ex-1');
  });
});
