import { Test } from '@nestjs/testing';
import { PmTestController } from './pm-test.controller';
import { PmTestService } from './pm-test.service';

/**
 * PmTestController parses optional numeric query params. The key non-trivial
 * paths are formLevel/limit being optional strings that must round-trip to
 * `undefined` (not NaN) when missing.
 */

describe('PmTestController', () => {
  let controller: PmTestController;
  let pmTest: jest.Mocked<PmTestService>;

  beforeEach(async () => {
    pmTest = {
      listSubjectsForUser: jest.fn(),
      listQuestions: jest.fn(),
      statsForUser: jest.fn(),
    } as unknown as jest.Mocked<PmTestService>;
    const moduleRef = await Test.createTestingModule({
      controllers: [PmTestController],
      providers: [{ provide: PmTestService, useValue: pmTest }],
    }).compile();
    controller = moduleRef.get(PmTestController);
  });

  it('subjects forwards only the JWT user id', () => {
    controller.subjects({ id: 'u' } as never);
    expect(pmTest.listSubjectsForUser).toHaveBeenCalledWith('u');
  });

  it('questions parses formLevel and limit, leaving them undefined when missing', () => {
    controller.questions({ id: 'u' } as never, 's-1');
    expect(pmTest.listQuestions).toHaveBeenCalledWith('u', {
      subjectId: 's-1',
      formLevel: undefined,
      limit: undefined,
    });
  });

  it('questions parses numeric query strings into numbers', () => {
    controller.questions({ id: 'u' } as never, 's-1', '2', '50');
    expect(pmTest.listQuestions).toHaveBeenCalledWith('u', {
      subjectId: 's-1',
      formLevel: 2,
      limit: 50,
    });
  });

  it('stats forwards only the JWT user id', () => {
    controller.stats({ id: 'u' } as never);
    expect(pmTest.statsForUser).toHaveBeenCalledWith('u');
  });
});
