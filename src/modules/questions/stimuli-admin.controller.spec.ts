import { Test } from '@nestjs/testing';
import { StimuliAdminController } from './stimuli-admin.controller';
import { StimuliService } from './stimuli.service';

describe('StimuliAdminController', () => {
  let controller: StimuliAdminController;
  let stimuli: jest.Mocked<StimuliService>;

  beforeEach(async () => {
    stimuli = {
      list: jest.fn(),
      getById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<StimuliService>;
    const moduleRef = await Test.createTestingModule({
      controllers: [StimuliAdminController],
      providers: [{ provide: StimuliService, useValue: stimuli }],
    }).compile();
    controller = moduleRef.get(StimuliAdminController);
  });

  it('list parses the limit query string', () => {
    controller.list('algebra', '30');
    expect(stimuli.list).toHaveBeenCalledWith({ search: 'algebra', limit: 30 });
  });

  it('list leaves limit undefined when the query is missing', () => {
    controller.list('algebra');
    expect(stimuli.list).toHaveBeenCalledWith({
      search: 'algebra',
      limit: undefined,
    });
  });

  it('create / update / remove forward the admin id', () => {
    controller.create({ id: 'a' } as never, { body: 'b' } as never);
    controller.update({ id: 'a' } as never, 's-1', { body: 'b' } as never);
    controller.remove({ id: 'a' } as never, 's-1');
    expect(stimuli.create).toHaveBeenCalledWith('a', { body: 'b' });
    expect(stimuli.update).toHaveBeenCalledWith('a', 's-1', { body: 'b' });
    expect(stimuli.delete).toHaveBeenCalledWith('a', 's-1');
  });
});
