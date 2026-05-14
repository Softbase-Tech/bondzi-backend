import { Test } from '@nestjs/testing';
import { SrsController } from './srs.controller';
import { SrsService } from './srs.service';

/**
 * Controller is a pure pass-through to SrsService. Tests below assert the
 * arguments forwarded — particularly that the user id always comes from
 * `@CurrentUser`, never from the body / query.
 */
describe('SrsController', () => {
  let controller: SrsController;
  let srs: jest.Mocked<SrsService>;

  beforeEach(async () => {
    srs = {
      getDue: jest.fn(),
      review: jest.fn(),
      stats: jest.fn(),
    } as unknown as jest.Mocked<SrsService>;

    const moduleRef = await Test.createTestingModule({
      controllers: [SrsController],
      providers: [{ provide: SrsService, useValue: srs }],
    }).compile();

    controller = moduleRef.get(SrsController);
  });

  it('GET /srs/due forwards the user id and the optional subject filter', () => {
    controller.due({ id: 'user-1' } as never, 'subj-1');
    expect(srs.getDue).toHaveBeenCalledWith('user-1', 'subj-1');
  });

  it('GET /srs/due works without a subject id', () => {
    controller.due({ id: 'user-1' } as never);
    expect(srs.getDue).toHaveBeenCalledWith('user-1', undefined);
  });

  it('POST /srs/:qid/review forwards user id, question id and quality', () => {
    controller.review({ id: 'user-1' } as never, 'q-1', {
      quality: 4,
    } as never);
    expect(srs.review).toHaveBeenCalledWith('user-1', 'q-1', 4);
  });

  it('GET /srs/stats forwards only the user id', () => {
    controller.stats({ id: 'user-1' } as never);
    expect(srs.stats).toHaveBeenCalledWith('user-1');
  });
});
