import { Test } from '@nestjs/testing';
import { AdminPmTestController } from './admin-pm-test.controller';
import { AdminPmTestService } from './admin-pm-test.service';

describe('AdminPmTestController', () => {
  let controller: AdminPmTestController;
  let service: jest.Mocked<AdminPmTestService>;

  beforeEach(async () => {
    service = {
      preview: jest.fn(),
      generate: jest.fn(),
      listJobs: jest.fn(),
      getJob: jest.fn(),
      listReview: jest.fn(),
      bulkReview: jest.fn(),
      publish: jest.fn(),
      archive: jest.fn(),
    } as unknown as jest.Mocked<AdminPmTestService>;
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminPmTestController],
      providers: [{ provide: AdminPmTestService, useValue: service }],
    }).compile();
    controller = moduleRef.get(AdminPmTestController);
  });

  it('generate and generateConfirm route to the SAME service method', () => {
    controller.generate(
      { id: 'a' } as never,
      { confirmationToken: 't' } as never,
    );
    controller.generateConfirm(
      { id: 'a' } as never,
      { confirmationToken: 't' } as never,
    );
    expect(service.generate).toHaveBeenCalledTimes(2);
  });

  it('review parses formLevel/page/limit and leaves them undefined when missing', () => {
    controller.review('wassce', undefined, 's-1');
    expect(service.listReview).toHaveBeenCalledWith({
      examType: 'wassce',
      formLevel: undefined,
      subjectId: 's-1',
      page: undefined,
      limit: undefined,
    });
  });

  it('review forwards numeric query strings as numbers', () => {
    controller.review('wassce', '3', 's-1', '2', '20');
    expect(service.listReview).toHaveBeenCalledWith({
      examType: 'wassce',
      formLevel: 3,
      subjectId: 's-1',
      page: 2,
      limit: 20,
    });
  });

  it('publish + archive forward only the id', () => {
    controller.publish('q-1');
    controller.archive('q-2');
    expect(service.publish).toHaveBeenCalledWith('q-1');
    expect(service.archive).toHaveBeenCalledWith('q-2');
  });
});
