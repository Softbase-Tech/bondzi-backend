import { Test } from '@nestjs/testing';
import { AdminExplanationsController } from './admin-explanations.controller';
import { AdminExplanationsService } from './admin-explanations.service';

describe('AdminExplanationsController', () => {
  let controller: AdminExplanationsController;
  let service: jest.Mocked<AdminExplanationsService>;

  beforeEach(async () => {
    service = {
      preview: jest.fn(),
      generate: jest.fn(),
      listJobs: jest.fn(),
      streamProgress: jest.fn(),
      getJob: jest.fn(),
      listPending: jest.fn(),
      regenerate: jest.fn(),
    } as unknown as jest.Mocked<AdminExplanationsService>;
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminExplanationsController],
      providers: [{ provide: AdminExplanationsService, useValue: service }],
    }).compile();
    controller = moduleRef.get(AdminExplanationsController);
  });

  it('generate forwards the admin id + DTO so the audit row carries triggeredBy', () => {
    controller.generate(
      { id: 'admin-1' } as never,
      {
        confirmationToken: 'tok',
      } as never,
    );
    expect(service.generate).toHaveBeenCalledWith('admin-1', {
      confirmationToken: 'tok',
    });
  });

  it('regenerate normalises an unknown model param to claude-sonnet', () => {
    controller.regenerate({ id: 'admin-1' } as never, 'q-1', 'random-text');
    expect(service.regenerate).toHaveBeenCalledWith(
      'admin-1',
      'q-1',
      'claude-sonnet',
    );
  });

  it('regenerate honours an explicit claude-haiku request', () => {
    controller.regenerate({ id: 'admin-1' } as never, 'q-1', 'claude-haiku');
    expect(service.regenerate).toHaveBeenCalledWith(
      'admin-1',
      'q-1',
      'claude-haiku',
    );
  });

  it('pending parses the page and limit query strings', () => {
    controller.pending('wassce' as never, 's-1', '2', '40');
    expect(service.listPending).toHaveBeenCalledWith({
      examType: 'wassce',
      subjectId: 's-1',
      page: 2,
      limit: 40,
    });
  });
});
